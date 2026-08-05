export class AgentError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AgentError";
    this.code = options.code || "AGENT_ERROR";
    this.status = options.status || 500;
    this.cause = options.cause;
    this.details = options.details;
  }
}

const safeEndpoint = (rawUrl) => {
  try {
    const parsed = new URL(String(rawUrl || ""));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(rawUrl || "").split("?")[0].slice(0, 240);
  }
};

export const safeJsonParse = (value, fallback = null) => {
  if (typeof value !== "string") return value ?? fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

export const withTimeout = (timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("Request timed out")), timeoutMs);
  return {
    signal: controller.signal,
    cancel: () => clearTimeout(timer),
  };
};

export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

const DEFAULT_RETRY_ATTEMPTS = 2;
const DEFAULT_RETRY_BASE_DELAY_MS = 400;
const RETRYABLE_HTTP_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

const toPositiveInt = (value, fallback) => {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

export const isRetryableHttpStatus = (status) => RETRYABLE_HTTP_STATUSES.has(Number(status));

export const isRetryableNetworkError = (error) => {
  if (!error) return false;
  // Undici 在响应体读取期间被对端断开时，顶层常是 TypeError("terminated")，
  // 真正的 UND_ERR_SOCKET 则藏在 cause。逐层检查，避免将这类瞬断误判为不可重试。
  const seen = new Set();
  let current = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof AgentError) {
      if (current.code === "HTTP_ERROR" && isRetryableHttpStatus(current.status)) return true;
    } else {
      const name = String(current.name || "");
      const code = String(current.code || "");
      const message = String(current.message || "").trim().toLowerCase();
      if (
        name === "AbortError" ||
        message === "terminated" ||
        message === "request timed out" ||
        code === "UND_ERR_SOCKET" ||
        code === "UND_ERR_ABORTED" ||
        code === "UND_ERR_CONNECT_TIMEOUT" ||
        code === "UND_ERR_HEADERS_TIMEOUT" ||
        code === "UND_ERR_BODY_TIMEOUT" ||
        code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "EAI_AGAIN" ||
        code === "ENOTFOUND" ||
        code === "ECONNREFUSED"
      ) return true;
    }
    current = current.cause;
  }
  return false;
};

export const retryDelayMs = (attempt, baseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS) => {
  const exponential = Math.max(0, baseDelayMs) * (2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * Math.max(50, Math.max(0, baseDelayMs)));
  return Math.min(exponential + jitter, 5000);
};

export const fetchJson = async (url, options = {}) => {
  const {
    timeoutMs,
    logger,
    interfaceName = "http.fetch",
    signal,
    retries,
    retryBaseDelayMs,
    logFields = {},
    // 部分上游（如 TikHub 抖音接口）会把偶发限流/抖动以 HTTP 400 返回，与真正的
    // 参数错误不可区分；调用方可通过 retryableExtraStatuses 显式声明该端点的 400
    // 属于可重试抖动。默认不放宽，避免掩盖真正的客户端错误。接受 Set | number[] | number。
    retryableExtraStatuses,
    ...fetchOptions
  } = options;
  const maxRetries = toPositiveInt(retries, DEFAULT_RETRY_ATTEMPTS);
  const maxAttempts = maxRetries + 1;
  const baseDelayMs = toPositiveInt(retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
  const method = fetchOptions.method || "GET";
  const endpoint = safeEndpoint(url);
  const extraRetryable = (() => {
    if (retryableExtraStatuses == null) return new Set();
    if (retryableExtraStatuses instanceof Set) return retryableExtraStatuses;
    if (Array.isArray(retryableExtraStatuses)) return new Set(retryableExtraStatuses);
    return new Set([Number(retryableExtraStatuses)]);
  })();
  const isRetryableStatus = (status) => isRetryableHttpStatus(status) || extraRetryable.has(Number(status));

  let lastError = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const timeout = withTimeout(timeoutMs || 60000);
    const startedAt = Date.now();
    logger?.info("external.request.start", {
      interface: interfaceName,
      method,
      endpoint,
      attempt,
      maxAttempts,
      ...logFields,
    });

    try {
      const response = await fetch(url, {
        ...fetchOptions,
        signal: signal || timeout.signal,
      });
      const text = await response.text();
      const data = text ? safeJsonParse(text, { raw: text }) : null;
      logger?.info("external.request.end", {
        interface: interfaceName,
        method,
        endpoint,
        status: response.status,
        durationMs: Date.now() - startedAt,
        attempt,
        maxAttempts,
        ...logFields,
      });

      if (!response.ok) {
        // 错误会被多层 logger 记录；只使用已去除 query 的 endpoint，避免把
        // TikHub cursor/max_cursor、签名或其他敏感查询参数写入日志。
        const error = new AgentError(`HTTP ${response.status} from ${endpoint}`, {
          status: response.status,
          code: "HTTP_ERROR",
          details: data,
        });
        lastError = error;
        if (attempt < maxAttempts && isRetryableStatus(response.status)) {
          const delayMs = retryDelayMs(attempt, baseDelayMs);
          logger?.warn("external.request.retry", {
            interface: interfaceName,
            method,
            endpoint,
            attempt,
            nextAttempt: attempt + 1,
            maxAttempts,
            delayMs,
            reason: `HTTP ${response.status}`,
            ...logFields,
          });
          timeout.cancel();
          await sleep(delayMs);
          continue;
        }
        throw error;
      }

      return { response, data, text };
    } catch (error) {
      lastError = error;
      const retryable = isRetryableNetworkError(error);
      if (attempt < maxAttempts && retryable) {
        const delayMs = retryDelayMs(attempt, baseDelayMs);
        logger?.warn("external.request.retry", {
          interface: interfaceName,
          method,
          endpoint,
          attempt,
          nextAttempt: attempt + 1,
          maxAttempts,
          delayMs,
          reason: error instanceof Error ? error.message : "Network request failed",
          code: error?.code,
          ...logFields,
        });
        timeout.cancel();
        await sleep(delayMs);
        continue;
      }

      if (error instanceof AgentError) {
        logger?.error("external.request.error", {
          interface: interfaceName,
          method,
          endpoint,
          durationMs: Date.now() - startedAt,
          attempt,
          maxAttempts,
          error: error.message,
          code: error.code,
          status: error.status,
          ...logFields,
        });
        throw error;
      }

      logger?.error("external.request.error", {
        interface: interfaceName,
        method,
        endpoint,
        durationMs: Date.now() - startedAt,
        attempt,
        maxAttempts,
        error: error instanceof Error ? error.message : "Network request failed",
        code: error?.code,
        ...logFields,
      });
      throw new AgentError(error instanceof Error ? error.message : "Network request failed", {
        code: "NETWORK_ERROR",
        cause: error,
      });
    } finally {
      timeout.cancel();
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new AgentError("Network request failed", { code: "NETWORK_ERROR" });
};

export const appendQuery = (baseUrl, params) => {
  const url = new URL(baseUrl);
  Object.entries(params || {}).forEach(([key, value]) => {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  });
  return url.toString();
};

export const setSseHeaders = (res, status = 200) => {
  if (typeof res.status === "function") {
    res.status(status);
  } else {
    res.statusCode = status;
  }
  res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
  res.setHeader("Cache-Control", "no-cache, no-transform");
  res.setHeader("Connection", "keep-alive");
};

export const sendSseEvent = (res, event, payload = {}) => {
  const data = typeof payload === "string" ? payload : JSON.stringify(payload);
  res.write(`event: ${event}\ndata: ${data}\n\n`);
};

export const cleanModelText = (value) => {
  let text = String(value || "").trim();
  text = text.replace(/^```(?:json|text|markdown)?\s*/i, "").replace(/```$/i, "").trim();
  return text;
};

export const extractFirstJsonObjectText = (value) => {
  const text = cleanModelText(value);
  if (!text) return "";
  if (/^"output"\s*:/.test(text)) return `{${text}}`;
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return text;
};
