import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  MAP_SELECTION_IMAGE_TARGET_SCHEMA,
  MapSelectionImageTargetError,
  parseMapSelectionImageTarget,
} from "../public/map-editor/map-selection-image-target.js";

const SELECTION_VALIDATOR_PATH = fileURLToPath(
  new URL("../scripts/validate-map-selection-image.mjs", import.meta.url),
);
const DEFAULT_VALIDATION_MEMORY_MB = 256;
const DEFAULT_VALIDATION_TIMEOUT_MS = 30_000;
const DEFAULT_VALIDATION_OUTPUT_BYTES = 2 * 1024 * 1024;

const OPERATIONS = new Set(["generate", "edit", "outpaint"]);
const MASK_MODES = new Set(["strict", "soft"]);
const PRESERVE_MODES = new Set(["exact", "seamless"]);
const ALIGNMENT_POLICIES = new Set(["reject", "pad-and-crop", "rescale-and-crop"]);
const OPERATION_PURPOSES = Object.freeze({
  generate: Object.freeze(["layer-image", "tileset", "prop"]),
  edit: Object.freeze(["layer-image", "tileset", "prop"]),
  outpaint: Object.freeze(["layer-image", "tileset"]),
});
const PRIVILEGED_KEYS = new Set([
  "project",
  "projectPath",
  "projectRoot",
  "destination",
  "destinations",
  "outputPath",
  "publishPath",
  "providerUser",
  "providerUserId",
  "user",
]);
const CLIENT_PATH_KEYS = new Set(["sourcePath", "sourcePaths", "maskPath"]);
const CRITICAL_TARGET_PATHS = Object.freeze([
  "purpose",
  "map",
  "layer.id",
  "layer.type",
  "layer.path",
  "selection",
  "expansion",
  "target",
  "policies.maskMode",
  "policies.preserveSource",
  "logicalCanvas",
]);

export { MAP_SELECTION_IMAGE_TARGET_SCHEMA, MapSelectionImageTargetError };
export const MAP_SELECTION_IMAGE_OPERATIONS = Object.freeze([...OPERATIONS]);
export const MAP_SELECTION_IMAGE_OPERATION_PURPOSES = OPERATION_PURPOSES;

export class MapSelectionImageContractError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "MapSelectionImageContractError";
    this.code = code;
    this.statusCode = code === "MAP_IMAGE_SELECTION_VERSION_CONFLICT" ? 409 : 400;
    Object.assign(this, details);
  }
}

/**
 * Run authoritative Tiled selection validation outside the main server heap.
 * The child hashes and parses the current TMJ, then rebuilds every derived
 * coordinate through validateMapSelectionImageTaskContract().
 */
export async function validateMapSelectionImageTaskInChild(input, options = {}) {
  const targetPath = String(input?.targetPath || "");
  if (!targetPath) {
    throw new MapSelectionImageContractError(
      "MAP_IMAGE_SELECTION_MAP_INVALID",
      "地图选区校验缺少当前地图路径",
    );
  }
  const memoryMb = boundedProcessInteger(
    options.memoryMb,
    DEFAULT_VALIDATION_MEMORY_MB,
    64,
    4096,
    "地图选区校验内存预算无效",
  );
  const timeoutMs = boundedProcessInteger(
    options.timeoutMs,
    DEFAULT_VALIDATION_TIMEOUT_MS,
    1_000,
    300_000,
    "地图选区校验超时无效",
  );
  const maxOutputBytes = boundedProcessInteger(
    options.maxOutputBytes,
    DEFAULT_VALIDATION_OUTPUT_BYTES,
    64 * 1024,
    16 * 1024 * 1024,
    "地图选区校验输出上限无效",
  );
  const maxMapBytes = boundedProcessInteger(
    input?.maxMapBytes,
    4 * 1024 * 1024 * 1024,
    1,
    Number.MAX_SAFE_INTEGER,
    "地图选区校验读取上限无效",
  );
  const payload = JSON.stringify({
    target: input.serializedTarget,
    editorStateId: input.currentEditorStateId,
    operation: input.operation,
    request: input.request,
    expectedLogicalCanvas: input.expectedLogicalCanvas ?? null,
    limits: input.limits ?? null,
    maxMapBytes,
  });
  if (Buffer.byteLength(payload) > maxOutputBytes) {
    throw new MapSelectionImageContractError(
      "MAP_IMAGE_SELECTION_PAYLOAD_LIMIT",
      "地图选区校验参数超过大小上限",
    );
  }

  const child = spawn(process.execPath, [
    `--max-old-space-size=${memoryMb}`,
    SELECTION_VALIDATOR_PATH,
    targetPath,
    String(input.currentMapVersion || ""),
  ], { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let overflow = false;
  const appendBounded = (previous, chunk) => {
    if (previous.length + chunk.length > maxOutputBytes) {
      overflow = true;
      child.kill("SIGKILL");
      return previous;
    }
    return Buffer.concat([previous, chunk]);
  };
  child.stdout.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
  child.stderr.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
  // The validator may reject before consuming stdin (for example a stale
  // version or malformed map). Treat a resulting EPIPE as normal shutdown.
  child.stdin.on("error", () => {});
  const timeout = setTimeout(() => child.kill("SIGKILL"), timeoutMs);
  child.stdin.end(payload);
  const result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal }));
  }).finally(() => clearTimeout(timeout));
  if (overflow) {
    throw new MapSelectionImageContractError(
      "MAP_IMAGE_SELECTION_OUTPUT_LIMIT",
      "地图选区校验输出超过上限",
    );
  }
  if (result.code !== 0) {
    let details = null;
    try { details = JSON.parse(stderr.toString("utf8")); } catch { /* bounded fallback below */ }
    const timedOut = result.signal === "SIGKILL" && !details;
    const error = new MapSelectionImageContractError(
      details?.code || (timedOut ? "MAP_IMAGE_SELECTION_VALIDATION_LIMIT" : "MAP_IMAGE_SELECTION_VALIDATION_FAILED"),
      details?.message || details?.error || (timedOut
        ? "地图选区校验超过管理员设置的时间或内存预算"
        : "地图选区校验失败"),
    );
    if (Number.isInteger(details?.statusCode)) error.statusCode = details.statusCode;
    throw error;
  }
  try {
    return JSON.parse(stdout.toString("utf8")).contract;
  } catch {
    throw new MapSelectionImageContractError(
      "MAP_IMAGE_SELECTION_VALIDATION_RESPONSE",
      "地图选区校验进程返回了无效结果",
    );
  }
}

/**
 * Validate an untrusted browser selection target against the authoritative
 * Tiled document and bind it to one provider-independent image operation.
 *
 * `request` is optional, but when supplied it is inspected for privileged
 * client fields and is also used as the source of operation/policy values.
 * The returned target is rebuilt from the authoritative document; no caller
 * supplied derived coordinate is trusted.
 */
export function validateMapSelectionImageTaskContract(serializedTarget, {
  document,
  currentMapVersion,
  currentEditorStateId = null,
  operation = null,
  request = null,
  maskMode = null,
  preserveSource = null,
  blendMargin = null,
  alignmentPolicy = null,
  expectedLogicalCanvas = null,
  limits = null,
} = {}) {
  assertSafeMapSelectionImageClientPayload(serializedTarget, { label: "地图选区目标" });
  if (request != null) assertSafeMapSelectionImageClientPayload(request, { label: "地图生图请求" });

  let target;
  try {
    target = parseMapSelectionImageTarget(serializedTarget, {
      document,
      currentMapVersion,
      currentEditorStateId,
      limits,
    });
  } catch (error) {
    if (error?.code === "MAP_IMAGE_SELECTION_VERSION_CONFLICT") throw error;
    throw error;
  }
  assertCriticalTargetMatches(serializedTarget, target);
  if (expectedLogicalCanvas != null) {
    assertCanvasMatches(expectedLogicalCanvas, target.logicalCanvas, "实际输入画布");
  }

  const normalizedOperation = enumValue(
    operation ?? request?.operation,
    OPERATIONS,
    "MAP_IMAGE_SELECTION_OPERATION_INVALID",
    "地图选区生图操作无效",
  );
  if (!OPERATION_PURPOSES[normalizedOperation].includes(target.purpose)) {
    throw contractError(
      "MAP_IMAGE_SELECTION_OPERATION_TARGET_INVALID",
      `操作 ${normalizedOperation} 不能用于 ${target.purpose} 目标`,
      { operation: normalizedOperation, purpose: target.purpose },
    );
  }

  const expansionTotal = Object.values(target.expansion.world).reduce((sum, value) => sum + value, 0);
  if (normalizedOperation === "outpaint" ? expansionTotal === 0 : expansionTotal !== 0) {
    throw contractError(
      "MAP_IMAGE_SELECTION_OPERATION_TARGET_INVALID",
      normalizedOperation === "outpaint"
        ? "扩图操作至少需要一个大于零的扩展边界"
        : "只有扩图操作可以扩大地图选区画布",
      { operation: normalizedOperation },
    );
  }

  const suppliedMaskMode = maskMode ?? request?.maskMode ?? serializedTarget?.policies?.maskMode;
  const suppliedPreserveSource = preserveSource
    ?? request?.preserveSource
    ?? serializedTarget?.policies?.preserveSource;
  assertSerializedPolicyAgreement(serializedTarget, "maskMode", maskMode ?? request?.maskMode);
  assertSerializedPolicyAgreement(serializedTarget, "preserveSource", preserveSource ?? request?.preserveSource);

  const explicitPolicies = {
    maskMode: maskMode ?? request?.maskMode,
    preserveSource: preserveSource ?? request?.preserveSource,
    blendMargin: blendMargin ?? request?.blendMargin,
    alignmentPolicy: alignmentPolicy ?? request?.alignmentPolicy,
  };
  if (normalizedOperation === "generate") {
    rejectIrrelevantPolicies(explicitPolicies, Object.keys(explicitPolicies), normalizedOperation);
  } else if (normalizedOperation === "edit") {
    rejectIrrelevantPolicies(explicitPolicies, ["preserveSource", "blendMargin", "alignmentPolicy"], normalizedOperation);
  } else {
    rejectIrrelevantPolicies(explicitPolicies, ["maskMode"], normalizedOperation);
  }
  const policies = operationPolicies(normalizedOperation, {
    maskMode: normalizedOperation === "edit" ? suppliedMaskMode : null,
    preserveSource: normalizedOperation === "outpaint" ? suppliedPreserveSource : null,
    blendMargin: normalizedOperation === "outpaint"
      ? blendMargin ?? request?.blendMargin ?? serializedTarget?.policies?.blendMargin
      : null,
    alignmentPolicy: normalizedOperation === "outpaint"
      ? alignmentPolicy ?? request?.alignmentPolicy ?? serializedTarget?.policies?.alignmentPolicy
      : null,
  });

  return deepFreeze({
    schema: MAP_SELECTION_IMAGE_TARGET_SCHEMA,
    operation: normalizedOperation,
    target,
    policies,
  });
}

/**
 * Reject authority-bearing fields and unsafe source/mask paths in an
 * untrusted map-image value. This deliberately does not inspect the Tiled
 * document, so unknown Tiled fields remain untouched.
 */
export function assertSafeMapSelectionImageClientPayload(value, { label = "地图生图参数" } = {}) {
  if (value == null) return true;
  const seen = new WeakSet();
  inspectClientValue(value, "$", label, seen, 0);
  return true;
}

function operationPolicies(operation, values) {
  if (operation === "generate") {
    rejectIrrelevantPolicies(values, ["maskMode", "preserveSource", "blendMargin", "alignmentPolicy"], operation);
    return { maskMode: null, preserveSource: null, blendMargin: null, alignmentPolicy: null };
  }
  if (operation === "edit") {
    rejectIrrelevantPolicies(values, ["preserveSource", "blendMargin", "alignmentPolicy"], operation);
    return {
      maskMode: enumValue(
        values.maskMode,
        MASK_MODES,
        "MAP_IMAGE_SELECTION_MASK_MODE_INVALID",
        "选区编辑蒙版模式无效",
      ),
      preserveSource: null,
      blendMargin: null,
      alignmentPolicy: null,
    };
  }
  rejectIrrelevantPolicies(values, ["maskMode"], operation);
  const normalizedPreserve = enumValue(
    values.preserveSource,
    PRESERVE_MODES,
    "MAP_IMAGE_SELECTION_PRESERVE_MODE_INVALID",
    "扩图原图保留模式无效",
  );
  const normalizedAlignment = enumValue(
    values.alignmentPolicy ?? "reject",
    ALIGNMENT_POLICIES,
    "MAP_IMAGE_SELECTION_ALIGNMENT_POLICY_INVALID",
    "扩图尺寸对齐策略无效",
  );
  let normalizedMargin = null;
  if (normalizedPreserve === "seamless") {
    normalizedMargin = boundedInteger(
      values.blendMargin,
      1,
      512,
      "MAP_IMAGE_SELECTION_BLEND_MARGIN_INVALID",
      "无缝扩图过渡宽度必须是 1 到 512 的整数",
    );
  } else if (values.blendMargin != null) {
    throw contractError(
      "MAP_IMAGE_SELECTION_BLEND_MARGIN_INVALID",
      "只有 seamless 原图保留模式可以指定过渡宽度",
    );
  }
  return {
    maskMode: null,
    preserveSource: normalizedPreserve,
    blendMargin: normalizedMargin,
    alignmentPolicy: normalizedAlignment,
  };
}

function rejectIrrelevantPolicies(values, names, operation) {
  for (const name of names) {
    if (values[name] == null) continue;
    throw contractError(
      "MAP_IMAGE_SELECTION_POLICY_OPERATION_INVALID",
      `操作 ${operation} 不能指定 ${name}`,
      { operation, policy: name },
    );
  }
}

function assertSerializedPolicyAgreement(serialized, name, supplied) {
  if (supplied == null || serialized?.policies?.[name] == null) return;
  if (String(supplied) === String(serialized.policies[name])) return;
  throw contractError(
    "MAP_IMAGE_SELECTION_POLICY_MISMATCH",
    `请求中的 ${name} 与选区目标不一致`,
    { policy: name },
  );
}

function assertCriticalTargetMatches(serialized, rebuilt) {
  for (const path of CRITICAL_TARGET_PATHS) {
    const supplied = pathValue(serialized, path);
    const expected = pathValue(rebuilt, path);
    if (sameJsonValue(supplied, expected)) continue;
    const code = path === "logicalCanvas"
      ? "MAP_IMAGE_SELECTION_CANVAS_MISMATCH"
      : "MAP_IMAGE_SELECTION_DERIVED_MISMATCH";
    throw contractError(
      code,
      path === "logicalCanvas"
        ? "客户端逻辑画布尺寸与地图选区计算结果不一致"
        : `客户端地图选区派生字段 ${path} 与当前地图不一致`,
      { field: path },
    );
  }
}

function assertCanvasMatches(supplied, expected, label) {
  if (!supplied || typeof supplied !== "object" || Array.isArray(supplied)) {
    throw contractError("MAP_IMAGE_SELECTION_CANVAS_INVALID", `${label}尺寸无效`);
  }
  const canvas = { width: Number(supplied.width), height: Number(supplied.height) };
  if (!Number.isSafeInteger(canvas.width) || !Number.isSafeInteger(canvas.height)
      || canvas.width < 1 || canvas.height < 1) {
    throw contractError("MAP_IMAGE_SELECTION_CANVAS_INVALID", `${label}尺寸无效`);
  }
  if (canvas.width !== expected.width || canvas.height !== expected.height) {
    throw contractError(
      "MAP_IMAGE_SELECTION_CANVAS_MISMATCH",
      `${label}尺寸与地图选区逻辑画布不一致`,
      { expectedCanvas: expected, suppliedCanvas: canvas },
    );
  }
}

function inspectClientValue(value, path, label, seen, depth) {
  if (value == null || typeof value !== "object") return;
  if (depth > 32) throw contractError("MAP_IMAGE_SELECTION_PAYLOAD_INVALID", `${label}嵌套过深`);
  if (seen.has(value)) throw contractError("MAP_IMAGE_SELECTION_PAYLOAD_INVALID", `${label}不能包含循环引用`);
  seen.add(value);
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      inspectClientValue(value[index], `${path}[${index}]`, label, seen, depth + 1);
    }
    return;
  }
  for (const key of Object.keys(value)) {
    const childPath = `${path}.${key}`;
    if (PRIVILEGED_KEYS.has(key)) {
      throw contractError(
        "MAP_IMAGE_SELECTION_PRIVILEGED_FIELD",
        `${label}不能指定 ${key}`,
        { field: childPath },
      );
    }
    if (CLIENT_PATH_KEYS.has(key)) validateClientPathField(key, value[key], childPath);
    inspectClientValue(value[key], childPath, label, seen, depth + 1);
  }
}

function validateClientPathField(key, value, field) {
  const values = key === "sourcePaths" ? value : [value];
  if (!Array.isArray(values) || values.length < 1) {
    throw contractError("MAP_IMAGE_SELECTION_SOURCE_PATH_INVALID", "源图片或蒙版路径无效", { field });
  }
  for (const entry of values) {
    const text = typeof entry === "string" ? entry : "";
    const parts = text.replaceAll("\\", "/").split("/");
    if (
      !text
      || text.startsWith("/")
      || /^[A-Za-z]:[\\/]/u.test(text)
      || /^\\\\/u.test(text)
      || text.includes("\\")
      || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(text)
      || parts.some((part) => !part || part === "." || part === "..")
      || /[\u0000-\u001f\u007f]/u.test(text)
    ) {
      throw contractError(
        "MAP_IMAGE_SELECTION_SOURCE_PATH_INVALID",
        "源图片和蒙版只能使用安全的工程相对路径",
        { field },
      );
    }
  }
}

function pathValue(value, dottedPath) {
  return dottedPath.split(".").reduce((current, key) => current?.[key], value);
}

function sameJsonValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right)
      && left.length === right.length
      && left.every((entry, index) => sameJsonValue(entry, right[index]));
  }
  if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index] && sameJsonValue(left[key], right[key]));
}

function enumValue(value, allowed, code, message) {
  const normalized = typeof value === "string" ? value : "";
  if (!allowed.has(normalized)) throw contractError(code, message);
  return normalized;
}

function boundedInteger(value, minimum, maximum, code, message) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw contractError(code, message);
  }
  return number;
}

function boundedProcessInteger(value, fallback, minimum, maximum, message) {
  const number = value == null ? fallback : Number(value);
  if (!Number.isSafeInteger(number) || number < minimum || number > maximum) {
    throw new MapSelectionImageContractError("MAP_IMAGE_SELECTION_VALIDATION_CONFIG", message);
  }
  return number;
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function contractError(code, message, details = {}) {
  return new MapSelectionImageContractError(code, message, details);
}
