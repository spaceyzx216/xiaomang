export const PROXY_BASE =
  import.meta.env.VITE_TIKHUB_PROXY_BASE ||
  import.meta.env.VITE_COZE_PROXY_BASE ||
  "http://127.0.0.1:18891";

type JsonObject = Record<string, any>;

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
    throw new Error(`代理接口不可用，当前返回的是页面内容（HTTP ${response.status}）。请检查 /tikhub-proxy 是否已正确转发到后端服务。`);
  }

  throw new Error(`接口返回了非 JSON 内容（HTTP ${response.status}）：${summarizeText(rawText)}`);
}
