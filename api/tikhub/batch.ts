import { TIKHUB_API_TOKEN, TIKHUB_BASE_URL, json, readBody, sanitizeUrl } from "../_lib/common.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { appendQuery, fetchJson } from "../_lib/contentAgent/http.js";
import { createRequestLogger, safeLink } from "../_lib/contentAgent/logger.js";

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  const logger = createRequestLogger("api.tikhub.batch", req.headers?.["x-request-id"]);
  const agentConfig = getContentAgentConfig();

  if (!TIKHUB_API_TOKEN) {
    return json(res, 500, { error: "Missing TIKHUB_API_TOKEN" });
  }

  const { urls } = readBody(req);
  logger.info("route.request.start", {
    interface: "/api/tikhub/batch",
    urlCount: Array.isArray(urls) ? urls.length : 0,
  });

  if (!Array.isArray(urls) || urls.length === 0) {
    logger.warn("route.validation.error", { error: "urls must be a non-empty array" });
    return json(res, 400, { error: "urls must be a non-empty array" });
  }

  const results: Array<Record<string, unknown>> = [];

  for (const rawUrl of urls) {
    const url = String(rawUrl || "").trim();
    if (!url) {
      results.push({ url: rawUrl, error: "Empty url" });
      continue;
    }

    const sanitizedUrl = sanitizeUrl(url);
    logger.info("tikhub.item.start", { url: safeLink(sanitizedUrl) });

    try {
      const secEndpoint = `${TIKHUB_BASE_URL}/api/v1/douyin/web/get_sec_user_id`;
      const { response: secResp, data: secUserResponse } = await fetchJson(
        appendQuery(secEndpoint, { url: sanitizedUrl }),
        {
          timeoutMs: agentConfig.requestTimeoutMs,
          retries: agentConfig.apiRetryAttempts,
          retryBaseDelayMs: agentConfig.apiRetryBaseDelayMs,
          logger,
          interfaceName: "tikhub:get_sec_user_id",
          headers: {
            Authorization: `Bearer ${TIKHUB_API_TOKEN}`,
          },
        },
      );
      const secUserId = secUserResponse?.data || secUserResponse?.sec_user_id;

      if (!secResp.ok || !secUserId) {
        results.push({
          url,
          secUserResponse,
          error: secUserResponse?.message || "Failed to resolve sec_user_id",
        });
        continue;
      }

      const videosEndpoint = `${TIKHUB_BASE_URL}/api/v1/douyin/app/v3/fetch_user_post_videos`;
      const { response: videosResp, data: videosResponse } = await fetchJson(
        appendQuery(videosEndpoint, {
          sec_user_id: secUserId,
          count: 20,
          max_cursor: 0,
          sort_type: 0,
        }),
        {
          timeoutMs: agentConfig.requestTimeoutMs,
          retries: agentConfig.apiRetryAttempts,
          retryBaseDelayMs: agentConfig.apiRetryBaseDelayMs,
          logger,
          interfaceName: "tikhub:fetch_user_post_videos",
          headers: {
            Authorization: `Bearer ${TIKHUB_API_TOKEN}`,
          },
        },
      );

      const dataBlock = videosResponse?.data;
      const videosList = Array.isArray(dataBlock)
        ? dataBlock
        : Array.isArray(dataBlock?.aweme_list)
          ? dataBlock.aweme_list
          : [];
      const authorName = videosList?.[0]?.author?.nickname;

      results.push({
        url,
        secUserId,
        authorName,
        videosCount: videosList.length,
        secUserResponse,
        videosResponse,
        error: videosResp.ok ? null : videosResponse?.message || "Failed to fetch videos",
      });
      logger.info("tikhub.item.end", {
        url: safeLink(sanitizedUrl),
        secUserId,
        videosCount: videosList.length,
        error: videosResp.ok ? "" : videosResponse?.message || "Failed to fetch videos",
      });
    } catch (error) {
      logger.error("tikhub.item.error", {
        url: safeLink(sanitizedUrl),
        error: error instanceof Error ? error.message : "Request failed",
        code: (error as any)?.code,
      });
      results.push({
        url,
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  }

  logger.info("route.request.done", {
    interface: "/api/tikhub/batch",
    resultCount: results.length,
    errorCount: results.filter(item => item?.error).length,
  });
  return json(res, 200, { results });
}
