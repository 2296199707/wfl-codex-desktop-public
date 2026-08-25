const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const MODEL_LIMIT = 500;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export async function listProviderModels({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 12_000,
  responseLimitBytes = RESPONSE_LIMIT_BYTES,
}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const headers = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await fetchImpl(modelsEndpoint(baseUrl), {
      method: "GET",
      headers,
      redirect: "error",
      signal: controller.signal,
    });
    const raw = await readBoundedBody(response, responseLimitBytes);
    const payload = parsePayload(raw);
    if (!response.ok) throw providerModelsResponseError(response.status);
    if (!Array.isArray(payload?.data)) throw modelsError(502, "供应商模型接口返回格式不正确");

    const models = [...new Set(payload.data
      .map((entry) => String(entry?.id || "").trim())
      .filter((id) => MODEL_ID_PATTERN.test(id)))]
      .sort((left, right) => left.localeCompare(right, "en"))
      .slice(0, MODEL_LIMIT);
    if (!models.length) throw modelsError(502, "供应商没有返回可用的模型 ID");
    return models;
  } catch (error) {
    if (error.name === "AbortError") throw modelsError(504, "查询供应商模型超时，请稍后重试");
    if (Number.isInteger(error.statusCode)) throw error;
    throw modelsError(502, "无法连接供应商模型接口");
  } finally {
    clearTimeout(timer);
  }
}

function modelsEndpoint(baseUrl) {
  let url;
  try {
    url = new URL(String(baseUrl || "").trim());
  } catch {
    throw modelsError(500, "供应商地址无效");
  }
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) throw modelsError(500, "供应商地址无效");
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  return url.href;
}

async function readBoundedBody(response, limit) {
  const chunks = [];
  let total = 0;
  if (!response.body) return "";
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) throw modelsError(502, "供应商模型响应过大");
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parsePayload(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    throw modelsError(502, "供应商模型接口返回了无效响应");
  }
}

function providerModelsResponseError(status) {
  if (status === 401 || status === 403) return modelsError(502, "供应商密钥无效或无模型查询权限");
  if (status === 429) return modelsError(429, "供应商模型查询过于频繁或额度不足");
  if (status >= 400 && status < 500) return modelsError(400, "供应商不支持当前模型查询地址");
  return modelsError(502, "供应商模型接口暂时不可用");
}

function modelsError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}
