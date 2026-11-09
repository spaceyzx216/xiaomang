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

/**
 * 单次请求的默认上限（毫秒）。
 *
 * 🔴 这个超时是必需的，不是保险丝：`fetch` 本身**永不超时**，而选题页的流程是
 *    「读选题库 → 逐条提脚本 → 逐条打标签」，每一步都 `await` 在这条请求上。
 *    任何一个请求悬挂（服务端重启、连接半开、平台把请求吞了），界面就永久停在
 *    那一句文案上 —— 用户实测遇到过「一直显示正在读取本账号的选题库…」，
 *    既不报错也不推进，完全看不出是网络问题。
 *
 * 取值要压过后端最慢的一条链路：后端单批预算 `GOLD_TRANSCRIPT_BUDGET_MS=240000`，
 * 所以这里给到 5 分钟以上，避免把正常的慢批次误杀。
 */
const DEFAULT_REQUEST_TIMEOUT_MS = 330_000;

export async function fetchWithRetry(
  input: RequestInfo | URL,
  init: RequestInit & { retries?: number; retryBaseDelayMs?: number; timeoutMs?: number } = {},
): Promise<Response> {
  const { retries = 2, retryBaseDelayMs = 350, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, ...fetchInit } = init;
  const maxAttempts = Math.max(1, retries + 1);
  let lastError: unknown = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    // 每次尝试各自计时：重试不该共用同一个预算，否则第一次慢就把后面的时间吃光。
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1000, Number(timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS));
    // 调用方自己传了 signal（例如"离开页面就取消"）时，两个信号取"任一触发"。
    const signal = fetchInit.signal
      ? AbortSignal.any([controller.signal, fetchInit.signal as AbortSignal])
      : controller.signal;
    try {
      const response = await fetch(input, { credentials: "include", ...fetchInit, signal });
      clearTimeout(timer);
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
      clearTimeout(timer);
      // 超时要报成"超时"，不能混进普通网络错误里 —— 用户看到 "signal is aborted"
      // 完全不知道发生了什么。
      lastError = controller.signal.aborted && (error as Error)?.name === "AbortError"
        ? new Error(`请求超时（超过 ${Math.round(timeoutMs / 1000)} 秒没有响应），请检查服务是否正常后重试`)
        : error;
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
