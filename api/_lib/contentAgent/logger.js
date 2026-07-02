import { randomUUID } from "crypto";

const LEVEL_TO_CONSOLE = {
  debug: "debug",
  info: "log",
  warn: "warn",
  error: "error",
};

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

  const write = (level, event, fields = {}) => {
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

    const writer = console[LEVEL_TO_CONSOLE[level] || "log"] || console.log;
    writer(parts.join(" "));
  };

  return {
    requestId,
    debug: (event, fields) => write("debug", event, fields),
    info: (event, fields) => write("info", event, fields),
    warn: (event, fields) => write("warn", event, fields),
    error: (event, fields) => write("error", event, fields),
    child: (childScope) => createRequestLogger(`${scope}.${childScope}`, requestId),
  };
};
