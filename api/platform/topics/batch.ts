import { json, readBody } from "../../_lib/common.js";
import { getContentAgentConfig } from "../../_lib/contentAgent/config.js";
import { createRequestLogger } from "../../_lib/contentAgent/logger.js";
import { fetchPlatformTopics } from "../../_lib/platformAdapters.js";

export const config = {
  maxDuration: 120,
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  const logger = createRequestLogger("api.platform.topics.batch", req.headers?.["x-request-id"]);
  const body = readBody(req);
  logger.info("route.request.start", {
    interface: "/api/platform/topics/batch",
    platform: body?.platform,
    accountCount: Array.isArray(body?.accounts) ? body.accounts.length : 0,
  });

  try {
    const payload = await fetchPlatformTopics(body, getContentAgentConfig(), { logger });
    logger.info("route.request.done", {
      interface: "/api/platform/topics/batch",
      resultCount: Array.isArray(payload?.results) ? payload.results.length : 0,
    });
    return json(res, 200, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Topic fetch failed";
    logger.error("route.request.error", {
      interface: "/api/platform/topics/batch",
      code: (error as any)?.code,
      error: message,
    });
    return json(res, (error as any)?.status || 500, { error: message, code: (error as any)?.code });
  }
}
