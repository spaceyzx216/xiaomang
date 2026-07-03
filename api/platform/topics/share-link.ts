import { json, readBody } from "../../_lib/common.js";
import { getContentAgentConfig } from "../../_lib/contentAgent/config.js";
import { createRequestLogger } from "../../_lib/contentAgent/logger.js";
import { fetchWeChatChannelsShareLink } from "../../_lib/platformAdapters.js";

export const config = {
  maxDuration: 120,
};

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  const logger = createRequestLogger("api.platform.topics.share-link", req.headers?.["x-request-id"]);
  const body = readBody(req);
  logger.info("route.request.start", {
    interface: "/api/platform/topics/share-link",
    platform: body?.platform,
    objectId: body?.objectId || body?.object_id,
  });

  try {
    const payload = await fetchWeChatChannelsShareLink(body, getContentAgentConfig(), { logger });
    logger.info("route.request.done", {
      interface: "/api/platform/topics/share-link",
      objectId: payload.objectId,
    });
    return json(res, 200, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Share link generation failed";
    logger.error("route.request.error", {
      interface: "/api/platform/topics/share-link",
      code: (error as any)?.code,
      error: message,
    });
    return json(res, (error as any)?.status || 500, { error: message, code: (error as any)?.code });
  }
}
