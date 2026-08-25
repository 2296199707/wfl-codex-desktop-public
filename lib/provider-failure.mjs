export const PROVIDER_FAILURE_KINDS = Object.freeze([
  "authentication",
  "quota",
  "rate-limit",
  "capacity",
  "connectivity",
  "unknown",
]);

const PROVIDER_FAILURE_KIND_SET = new Set(PROVIDER_FAILURE_KINDS);
const CONNECTIVITY_CODES = new Set([
  "ECONNABORTED",
  "ECONNREFUSED",
  "ECONNRESET",
  "EHOSTUNREACH",
  "ENETDOWN",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);

export function classifyProviderFailure(value) {
  const error = providerErrorObject(value);
  const statusCode = providerHttpStatus(value);
  const structuredKind = structuredProviderFailureKind(error?.codexErrorInfo);
  const statusKind = failureKindFromStatus(statusCode);
  const capacityKind = modelCapacityFailureKind(
    error?.codexErrorInfo,
    providerFailureMessage(value),
  );
  // Prefer Codex's semantic error when it is present. A usage-limit error
  // may be wrapped in HTTP 429/5xx by an adapter and must not become a
  // retryable rate-limit/connectivity failure.
  const explicitAccountKind = ["authentication", "quota", "rate-limit"].includes(structuredKind)
    ? structuredKind
    : null;
  const statusAccountKind = ["authentication", "quota"].includes(statusKind)
    ? statusKind
    : null;
  const kind = explicitAccountKind
    || statusAccountKind
    || capacityKind
    || statusKind
    || structuredKind
    || failureKindFromCode(error?.code ?? value?.code)
    || failureKindFromMessage(providerFailureMessage(value))
    || "unknown";
  return Object.freeze({
    kind,
    statusCode,
    retryable: kind === "connectivity" || kind === "rate-limit" || kind === "capacity",
    unlimitedRetryEligible: kind === "connectivity",
  });
}

export function normalizeProviderFailureKind(value) {
  return PROVIDER_FAILURE_KIND_SET.has(value) ? value : null;
}

export function providerFailureLabel(kind) {
  switch (normalizeProviderFailureKind(kind)) {
    case "authentication": return "认证失效";
    case "quota": return "额度耗尽";
    case "rate-limit": return "请求限流";
    case "capacity": return "模型容量不足";
    case "connectivity": return "连接异常";
    default: return "未知错误";
  }
}

export function providerFailureMessage(value) {
  const error = providerErrorObject(value);
  for (const candidate of [
    error?.message,
    error?.additionalDetails,
    value?.message,
    value?.params?.message,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim();
  }
  return "";
}

function providerErrorObject(value) {
  if (!value || typeof value !== "object") return null;
  if (value.params?.error && typeof value.params.error === "object") return value.params.error;
  if (value.error && typeof value.error === "object") return value.error;
  return value;
}

function providerHttpStatus(value) {
  const error = providerErrorObject(value);
  const codexStatus = findNamedStatus(error?.codexErrorInfo, "httpStatusCode");
  if (codexStatus !== null) return codexStatus;
  for (const candidate of [
    error?.httpStatusCode,
    error?.statusCode,
    error?.status,
    value?.httpStatusCode,
    value?.statusCode,
    value?.status,
  ]) {
    const status = normalizeHttpStatus(candidate);
    if (status !== null) return status;
  }
  return null;
}

function findNamedStatus(value, field, depth = 0, seen = new Set()) {
  if (!value || typeof value !== "object" || depth > 6 || seen.has(value)) return null;
  seen.add(value);
  if (Object.hasOwn(value, field)) {
    const status = normalizeHttpStatus(value[field]);
    if (status !== null) return status;
  }
  for (const nested of Object.values(value)) {
    const status = findNamedStatus(nested, field, depth + 1, seen);
    if (status !== null) return status;
  }
  return null;
}

function normalizeHttpStatus(value) {
  if (typeof value === "string" && !/^\d{3}$/.test(value.trim())) return null;
  const status = Number(value);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function failureKindFromStatus(status) {
  if (status === null) return null;
  if (status === 401 || status === 403) return "authentication";
  if (status === 402) return "quota";
  if (status === 429) return "rate-limit";
  if (status === 408 || status === 425 || status >= 500) return "connectivity";
  return "unknown";
}

function structuredProviderFailureKind(value) {
  if (typeof value === "string") return failureKindFromStructuredName(value);
  if (!value || typeof value !== "object") return null;
  const names = Object.keys(value);
  for (const name of names) {
    const kind = failureKindFromStructuredName(name);
    if (kind) return kind;
  }
  return null;
}

function failureKindFromStructuredName(value) {
  const name = String(value || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  if (!name) return null;
  if (/^(?:unauthorized|forbidden|invalidcredentials?|authenticationfailed|tokenexpired|tokenrevoked)$/.test(name)) {
    return "authentication";
  }
  if (/^(?:usagelimitexceeded|quotaexceeded|insufficientquota|creditsexhausted|billinglimitexceeded|workspace(?:owner|member)?creditsdepleted|workspace(?:owner|member)?usagelimitreached|workspacecreditsdepleted|workspaceusagelimitreached)$/.test(name)) {
    return "quota";
  }
  if (/^(?:ratelimit(?:ed|exceeded)?|toomanyrequests)$/.test(name)) return "rate-limit";
  if (/^(?:modelatcapacity|modelcapacityexceeded|modeloverloaded|modelunavailable)$/.test(name)) {
    return "capacity";
  }
  if (
    /^(?:httpconnectionfailed|responsestreamconnectionfailed|responsestreamdisconnected|networkerror|connectionfailed|timeout|serveroverloaded)$/
      .test(name)
  ) {
    return "connectivity";
  }
  // Without a status code this variant does not prove whether the last
  // attempts failed because of credentials, quota, policy, or transport.
  if (name === "responsetoomanyfailedattempts") return "unknown";
  return null;
}

function failureKindFromCode(value) {
  const code = String(value || "").trim().toUpperCase();
  return CONNECTIVITY_CODES.has(code) ? "connectivity" : null;
}

function failureKindFromMessage(value) {
  const message = String(value || "");
  if (!message) return null;
  if (/\b(?:401|403)\b|unauthori[sz]ed|forbidden|invalid (?:api )?key|credential|token (?:expired|revoked)|登录失效|账号失效|凭据|密钥失效/i.test(message)) {
    return "authentication";
  }
  if (/\b429\b|rate[ -]?limit|too many requests|throttl|请求过于频繁|限流/i.test(message)) {
    return "rate-limit";
  }
  if (/\b402\b|usage limit|quota|credit(?:s)? (?:exhausted|depleted)|额度(?:耗尽|不足|已用尽)|余额不足/i.test(message)) {
    return "quota";
  }
  if (modelCapacityFailureKind(null, message)) return "capacity";
  if (
    /\b(?:408|425|5\d\d)\b|offline|disconnect|connection|network|timed? ?out|timeout|temporar(?:y|ily)|unavailable|overload|socket|econn|enet|ehost|连接|断网|网络|超时|服务繁忙/i
      .test(message)
  ) {
    return "connectivity";
  }
  return null;
}

function modelCapacityFailureKind(structured, message) {
  const structuredName = typeof structured === "string"
    ? structured
    : structured && typeof structured === "object"
      ? Object.keys(structured).join(" ")
      : "";
  if (/model[\s_-]*(?:at[\s_-]*)?capacity|model[\s_-]*(?:overload|unavailable)/i.test(structuredName)) {
    return "capacity";
  }
  const text = String(message || "");
  if (
    /(?:selected\s+)?model.{0,48}(?:at\s+capacity|capacity\s+(?:is\s+)?(?:full|exhausted)|overload(?:ed)?|temporarily\s+unavailable)/i.test(text)
    || /(?:at\s+capacity|capacity\s+(?:is\s+)?(?:full|exhausted)|overload(?:ed)?).{0,48}model/i.test(text)
    || /模型.{0,32}(?:容量(?:已满|不足|耗尽)|已满载|过载|暂不可用|繁忙)/i.test(text)
  ) return "capacity";
  return null;
}
