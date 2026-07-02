import { json, readBody } from "../_lib/common.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { runTranslationAgent } from "../_lib/contentAgent/providers.js";

export const config = {
  maxDuration: 120,
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  const logger = createRequestLogger("api.agent.translation", req.headers?.["x-request-id"]);
  const body = readBody(req);
  const payload = body?.payload || body;

  logger.info("route.request.start", {
    interface: "/api/agent/translation",
    titleCount: Array.isArray(payload?.titles) ? payload.titles.length : 0,
    hookCount: Array.isArray(payload?.hooks) ? payload.hooks.length : 0,
    scriptCount: Array.isArray(payload?.scripts) ? payload.scripts.length : 0,
  });

  try {
    const result = await runTranslationAgent(payload, getContentAgentConfig(), { logger });
    logger.info("route.request.done", {
      interface: "/api/agent/translation",
      resultCount: Array.isArray(result?.translations) ? result.translations.length : 0,
    });
    return json(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Translation failed";
    logger.error("route.request.error", {
      interface: "/api/agent/translation",
      error: message,
      code: error?.code,
    });
    return json(res, error?.status || 500, { error: message, code: error?.code });
  }
}
