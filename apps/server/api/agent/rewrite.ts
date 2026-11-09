import { json, readBody } from "../_lib/common.js";
import { requireAuth } from "../_lib/auth.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { createRequestLogger } from "../_lib/contentAgent/logger.js";
import { runRewriteAgent } from "../_lib/contentAgent/providers.js";

export const config = {
  maxDuration: 120,
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }
  if (!await requireAuth(req, res)) return;

  const logger = createRequestLogger("api.agent.rewrite", req.headers?.["x-request-id"]);
  const body = readBody(req);
  const scripts = Array.isArray(body?.scripts) ? body.scripts : [];
  const targetPlatform = String(body?.targetPlatform || body?.target_platform || "douyin");

  logger.info("route.request.start", {
    interface: "/api/agent/rewrite",
    targetPlatform,
    scriptCount: scripts.length,
  });

  try {
    const result = await runRewriteAgent({ targetPlatform, scripts }, getContentAgentConfig(), { logger });
    logger.info("route.request.done", {
      interface: "/api/agent/rewrite",
      resultCount: Array.isArray(result?.results) ? result.results.length : 0,
    });
    return json(res, 200, result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rewrite failed";
    logger.error("route.request.error", {
      interface: "/api/agent/rewrite",
      error: message,
      code: error?.code,
    });
    return json(res, error?.status || 500, { error: message, code: error?.code });
  }
}
