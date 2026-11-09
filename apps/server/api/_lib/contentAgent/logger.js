import { randomUUID } from "crypto";

const LEVEL_TO_CONSOLE = {
  debug: "debug",
  info: "log",
  warn: "warn",
  error: "error",
};

const REDACTED = "[REDACTED]";
const MAX_JSON_DEPTH = 6;
const MAX_JSON_ARRAY_ITEMS = 30;
const MAX_JSON_OBJECT_KEYS = 50;
const MAX_JSON_STRING_LENGTH = 2_000;
const MAX_JSON_PREVIEW_LENGTH = 12_000;

const sensitiveDiagnosticKey = (key) => {
  const normalized = String(key || "").replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /(?:authorization|token|cookie|secret|password|apikey|decodekey|decryptkey|phone|mobile|telephone|contact|email|url|link|wechatid|wxid|qq(?:number)?|openid|unionid|address|location|idcard|identity)/.test(normalized);
};

const redactDiagnosticString = (value) => String(value)
  .replace(/https?:\/\/[^\s"'<>]+/gi, REDACTED)
  .replace(/\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b/gi, REDACTED)
  .replace(/(?<!\d)(?:\+?86[-\s]?)?1[3-9](?:[-\s]?\d){9}(?!\d)/g, REDACTED);

const sanitizeDiagnosticValue = (value, depth = 0, seen = new WeakSet()) => {
  if (value === null || value === undefined) return value ?? null;
  if (typeof value === "string") {
    const redacted = redactDiagnosticString(value);
    return redacted.length > MAX_JSON_STRING_LENGTH
      ? `${redacted.slice(0, MAX_JSON_STRING_LENGTH)}…[TRUNCATED:string]`
      : redacted;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "bigint") return `${value}n`;
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_JSON_DEPTH) return "[TRUNCATED:max_depth]";
  if (seen.has(value)) return "[TRUNCATED:circular]";
  seen.add(value);

  if (Array.isArray(value)) {
    const items = value.slice(0, MAX_JSON_ARRAY_ITEMS)
      .map(item => sanitizeDiagnosticValue(item, depth + 1, seen));
    if (value.length > MAX_JSON_ARRAY_ITEMS) items.push(`[TRUNCATED:${value.length - MAX_JSON_ARRAY_ITEMS} more items]`);
    return items;
  }

  const result = {};
  const keys = Object.keys(value).sort();
  for (const key of keys.slice(0, MAX_JSON_OBJECT_KEYS)) {
    result[key] = sensitiveDiagnosticKey(key)
      ? REDACTED
      : sanitizeDiagnosticValue(value[key], depth + 1, seen);
  }
  if (keys.length > MAX_JSON_OBJECT_KEYS) {
    result._truncated = `[TRUNCATED:${keys.length - MAX_JSON_OBJECT_KEYS} more keys]`;
  }
  return result;
};

const createJsonPreview = (payload) => {
  let text;
  try {
    text = JSON.stringify(sanitizeDiagnosticValue(payload));
  } catch {
    text = JSON.stringify({ _truncated: "[TRUNCATED:unserializable_payload]" });
  }
  if (text.length <= MAX_JSON_PREVIEW_LENGTH) return { text, truncated: false };
  let previewLength = Math.min(text.length, MAX_JSON_PREVIEW_LENGTH - 256);
  let preview = "";
  do {
    preview = JSON.stringify({
      _truncated: "[TRUNCATED:total_length]",
      preview: text.slice(0, previewLength),
    });
    previewLength = Math.floor(previewLength * 0.8);
  } while (preview.length > MAX_JSON_PREVIEW_LENGTH && previewLength > 0);
  return {
    text: preview,
    truncated: true,
  };
};

const sanitizeDiagnosticFields = (fields) => Object.fromEntries(
  Object.entries(fields || {}).map(([key, value]) => [
    key,
    sensitiveDiagnosticKey(key)
      ? REDACTED
      : typeof value === "string"
        ? redactDiagnosticString(value)
        : value,
  ]),
);

const safeValue = (value) => {
  if (value === undefined || value === null) return undefined;
  const text = typeof value === "object" ? JSON.stringify(value) : String(value);
  if (!text) return undefined;
  return text
    .replace(/\s+/g, " ")
    .replace(/"/g, '\\"')
    .slice(0, 600);
};

export const safeEndpoint = (rawUrl) => {
  try {
    const parsed = new URL(String(rawUrl || ""));
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(rawUrl || "").split("?")[0].slice(0, 240);
  }
};

export const safeLink = (rawUrl) => {
  try {
    const parsed = new URL(String(rawUrl || ""));
    const modalId = parsed.searchParams.get("modal_id");
    return modalId ? `${parsed.origin}${parsed.pathname}?modal_id=${modalId}` : `${parsed.origin}${parsed.pathname}`;
  } catch {
    return String(rawUrl || "").slice(0, 240);
  }
};

export const createRequestLogger = (scope, requestId = randomUUID()) => {
  const startedAt = Date.now();

  const write = (level, event, fields = {}, rawJsonFields = {}) => {
    const elapsedMs = Date.now() - startedAt;
    const parts = [
      `time="${new Date().toISOString()}"`,
      `level=${level}`,
      `scope=${scope}`,
      `requestId=${requestId}`,
      `event=${event}`,
      `elapsedMs=${elapsedMs}`,
    ];

    Object.entries(fields).forEach(([key, value]) => {
      const safe = safeValue(value);
      if (safe !== undefined) parts.push(`${key}="${safe}"`);
    });
    // JSON 预览不能走 safeValue：该函数会对每个字段截到 600 字符，
    // 会破坏上游字段结构并隐藏后半段诊断信息。
    Object.entries(rawJsonFields).forEach(([key, value]) => {
      if (typeof value === "string" && value) parts.push(`${key}=${value}`);
    });

    const writer = console[LEVEL_TO_CONSOLE[level] || "log"] || console.log;
    writer(parts.join(" "));
  };

  return {
    requestId,
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    infoJson: (event, fields, payload) => {
      const preview = createJsonPreview(payload);
      write("info", event, { ...sanitizeDiagnosticFields(fields), responseTruncated: preview.truncated }, { responseJson: preview.text });
    },
    errorJson: (event, fields, payload) => {
      const preview = createJsonPreview(payload);
      write("error", event, { ...sanitizeDiagnosticFields(fields), responseTruncated: preview.truncated }, { responseJson: preview.text });
    },
    child: (childScope) => createRequestLogger(`${scope}.${childScope}`, requestId),
  };
};
