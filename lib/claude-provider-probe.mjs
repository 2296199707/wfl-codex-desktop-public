const RESPONSE_LIMIT_BYTES = 2 * 1024 * 1024;
const MODEL_LIMIT = 500;
const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export async function probeClaudeProvider({
  baseUrl,
  apiKey,
  fetchImpl = fetch,
  timeoutMs = 12_000,
}) {
  const checkedAt = new Date().toISOString();
  let endpoint;
  try {
    endpoint = claudeModelsEndpoint(baseUrl);
  } catch {
    return probeFailure("configuration", "Claude Base URL 无效", {
      checkedAt,
      reachable: false,
    });
  }
  if (typeof apiKey !== "string" || !apiKey.trim() || apiKey.length > 4096) {
    return probeFailure("credentials", "请先填写 Claude API Key", {
      checkedAt,
      reachable: false,
    });
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "x-api-key": apiKey.trim(),
      },
      redirect: "error",
      signal: controller.signal,
    });
    const raw = await readBoundedBody(response, RESPONSE_LIMIT_BYTES);
    if (response.ok) {
      const payload = parsePayload(raw);
      const models = normalizeModelIds(payload?.data);
      if (!models.length) {
        return {
          ok: true,
          reachable: true,
          authenticated: true,
          discovery: "unavailable",
          category: "protocol",
          message: "连接成功，但供应商未返回可识别的模型列表；可以手动填写模型",
          models: [],
          checkedAt,
        };
      }
      return {
        ok: true,
        reachable: true,
        authenticated: true,
        discovery: "available",
        category: null,
        message: `连接成功，发现 ${models.length} 个模型`,
        models,
        checkedAt,
      };
    }
    if ([404, 405, 501].includes(response.status)) {
      return {
        ok: true,
        reachable: true,
        authenticated: null,
        discovery: "unsupported",
        category: "protocol",
        message: "目标服务器可连接，但不支持模型列表；可以手动填写模型",
        models: [],
        checkedAt,
      };
    }
    if ([401, 403].includes(response.status)) {
      return probeFailure("authentication", "Claude API Key 无效或没有模型查询权限", {
        checkedAt,
        reachable: true,
      });
    }
    if (response.status === 429) {
      return probeFailure("rate_limit", "供应商限流或额度不足，请稍后重试", {
        checkedAt,
        reachable: true,
      });
    }
    if (response.status >= 500) {
      return probeFailure("upstream", "供应商服务暂时不可用", {
        checkedAt,
        reachable: true,
      });
    }
    return probeFailure("protocol", "供应商不兼容当前 Claude 模型查询协议", {
      checkedAt,
      reachable: true,
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      return probeFailure("timeout", "连接供应商超时", { checkedAt, reachable: false });
    }
    if (error?.code === "CLAUDE_PROVIDER_RESPONSE_LIMIT") {
      return probeFailure("protocol", "供应商模型响应过大", { checkedAt, reachable: true });
    }
    return probeFailure(networkFailureCategory(error), networkFailureMessage(error), {
      checkedAt,
      reachable: false,
    });
  } finally {
    clearTimeout(timer);
  }
}

function probeFailure(category, message, { checkedAt, reachable }) {
  return {
    ok: false,
    reachable,
    authenticated: category === "authentication" ? false : null,
    discovery: "failed",
    category,
    message,
    models: [],
    checkedAt,
  };
}

function claudeModelsEndpoint(value) {
  const url = new URL(String(value || "").trim());
  const loopback = ["localhost", "127.0.0.1", "::1", "[::1]"].includes(url.hostname);
  if (
    url.username
    || url.password
    || url.search
    || url.hash
    || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))
  ) throw new Error("invalid");
  const pathname = url.pathname.replace(/\/+$/, "");
  if (/\/v1\/models$/i.test(pathname)) url.pathname = pathname;
  else if (/\/v1$/i.test(pathname)) url.pathname = `${pathname}/models`;
  else url.pathname = `${pathname}/v1/models`;
  return url.href;
}

async function readBoundedBody(response, limit) {
  const chunks = [];
  let total = 0;
  if (!response.body) return "";
  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > limit) {
      const error = new Error("response limit");
      error.code = "CLAUDE_PROVIDER_RESPONSE_LIMIT";
      throw error;
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks, total).toString("utf8");
}

function parsePayload(raw) {
  try {
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function normalizeModelIds(entries) {
  if (!Array.isArray(entries)) return [];
  return [...new Set(entries
    .map((entry) => String(entry?.id || "").trim())
    .filter((id) => MODEL_ID_PATTERN.test(id)))]
    .sort((left, right) => left.localeCompare(right, "en"))
    .slice(0, MODEL_LIMIT);
}

function networkFailureCategory(error) {
  const code = String(error?.cause?.code || error?.code || "").toUpperCase();
  if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) return "dns";
  if (code === "ECONNREFUSED") return "connection_refused";
  if (["ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"].includes(code)) return "timeout";
  if (
    code.startsWith("ERR_TLS")
    || code.includes("CERT")
    || code.includes("SSL")
    || code === "DEPTH_ZERO_SELF_SIGNED_CERT"
  ) return "tls";
  return "network";
}

function networkFailureMessage(error) {
  const category = networkFailureCategory(error);
  if (category === "dns") return "无法解析供应商域名";
  if (category === "connection_refused") return "供应商拒绝连接";
  if (category === "timeout") return "连接供应商超时";
  if (category === "tls") return "供应商 TLS 证书或握手失败";
  return "无法连接 Claude API 供应商";
}
