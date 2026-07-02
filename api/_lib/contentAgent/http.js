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
  if (error instanceof AgentError) {
    return error.code === "HTTP_ERROR" && isRetryableHttpStatus(error.status);
  }
  const name = String(error.name || "");
  const code = String(error.code || "");
  return (
    name === "AbortError" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    code === "UND_ERR_HEADERS_TIMEOUT" ||
    code === "UND_ERR_BODY_TIMEOUT" ||
    code === "ECONNRESET" ||
    code === "ETIMEDOUT" ||
    code === "EAI_AGAIN" ||
    code === "ENOTFOUND" ||
    code === "ECONNREFUSED"
  );
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
    ...fetchOptions
  } = options;
  const maxRetries = toPositiveInt(retries, DEFAULT_RETRY_ATTEMPTS);
  const maxAttempts = maxRetries + 1;
  const baseDelayMs = toPositiveInt(retryBaseDelayMs, DEFAULT_RETRY_BASE_DELAY_MS);
  const method = fetchOptions.method || "GET";
  const endpoint = safeEndpoint(url);

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
        const error = new AgentError(`HTTP ${response.status} from ${url}`, {
          status: response.status,
          code: "HTTP_ERROR",
          details: data,
        });
        lastError = error;
        if (attempt < maxAttempts && isRetryableHttpStatus(response.status)) {
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
