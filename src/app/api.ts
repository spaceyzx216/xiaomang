const RAW_PROXY_BASE =
  import.meta.env.VITE_API_PROXY_BASE ||
  import.meta.env.VITE_TIKHUB_PROXY_BASE ||
  "";

const normalizeProxyBase = (value: string) => {
  const trimmed = String(value || "").trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === "/") return "";
  if (trimmed === "/tikhub-proxy" || trimmed.endsWith("/tikhub-proxy")) {
    return "";
  }
  if (trimmed === "/api" || trimmed.endsWith("/api")) {
    return "";
  }
  return trimmed;
};

export const PROXY_BASE = normalizeProxyBase(RAW_PROXY_BASE);

export const apiUrl = (path: string) => {
  const normalizedPath = String(path || "").startsWith("/") ? path : `/${path}`;
  return `${PROXY_BASE}${normalizedPath}`;
};

type JsonObject = Record<string, any>;

const RETRYABLE_STATUSES = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
const NON_RETRYABLE_API_CODES = new Set([
  "FEISHU_CONFIG_MISSING",
  "TIKHUB_TOKEN_MISSING",
  "DOUBAO_ASR_CREDENTIALS_MISSING",
  "DOUBAO_VIDEO_CREDENTIALS_MISSING",
  "DEEPSEEK_TOKEN_MISSING",
  "ASR_INPUT_MISSING",
  "VIDEO_URL_MISSING",
  "FFMPEG_MISSING",
]);

const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

const retryDelay = (attempt: number, baseDelayMs = 350) => {
  const exponential = baseDelayMs * (2 ** Math.max(0, attempt - 1));
  const jitter = Math.floor(Math.random() * baseDelayMs);
  return Math.min(exponential + jitter, 3000);
};

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit & { retries?: number; retryBaseDelayMs?: number } = {},
): Promise<Response> {
  const { retries = 2, retryBaseDelayMs = 350, ...fetchInit } = init;
  const maxAttempts = Math.max(1, retries + 1);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch(input, fetchInit);
      if (!RETRYABLE_STATUSES.has(response.status) || attempt >= maxAttempts) {
        return response;
      }
      try {
        const data = await response.clone().json();
        const code = String(data?.code || "");
        if (NON_RETRYABLE_API_CODES.has(code) || /_MISSING$/.test(code)) {
          return response;
        }
      } catch {
        // Non-JSON retryable responses may still be transient.
      }
      await wait(retryDelay(attempt, retryBaseDelayMs));
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts) break;
      await wait(retryDelay(attempt, retryBaseDelayMs));
    }
  }

  throw lastError instanceof Error ? lastError : new Error("请求失败，请稍后重试");
}

const summarizeText = (value: string) => {
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 120) : "空响应";
};

export async function parseApiJson(response: Response): Promise<JsonObject> {
  const contentType = response.headers.get("content-type") || "";
  const rawText = await response.text();
  const trimmedText = rawText.trim();

  if (!trimmedText) {
    return {};
  }

  if (contentType.includes("application/json")) {
    try {
      return JSON.parse(trimmedText) as JsonObject;
    } catch {
      throw new Error(`接口返回了无效 JSON（HTTP ${response.status}）：${summarizeText(rawText)}`);
    }
  }

  if (trimmedText.startsWith("{") || trimmedText.startsWith("[")) {
    try {
      return JSON.parse(trimmedText) as JsonObject;
    } catch {
      throw new Error(`接口返回了无效 JSON（HTTP ${response.status}）：${summarizeText(rawText)}`);
    }
  }

  if (
    trimmedText.startsWith("<!DOCTYPE") ||
    trimmedText.startsWith("<html") ||
    trimmedText.startsWith("The page could not be found")
  ) {
    throw new Error(`代理接口不可用，当前返回的是页面内容（HTTP ${response.status}）。请检查 /api 路由与服务端配置是否正常。`);
  }

  throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）：${summarizeText(rawText)}`);
}
