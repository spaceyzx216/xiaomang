import { TIKHUB_API_TOKEN, TIKHUB_BASE_URL, json, readBody, sanitizeUrl } from "../_lib/common.js";
import { getContentAgentConfig } from "../_lib/contentAgent/config.js";
import { appendQuery, fetchJson } from "../_lib/contentAgent/http.js";
import { createRequestLogger, safeLink } from "../_lib/contentAgent/logger.js";
import {
  buildCombinedVideosResponse,
  collectRecentAwemePages,
  MAX_RECENT_DAYS,
  MAX_TOPIC_SLICE_PAGES,
  parseRecentDays,
} from "../_lib/topicPagination.js";

export const config = {
  maxDuration: 300,
};

// 每个浏览器请求只顺序处理 3 页。游标是上一页响应生成的，不能安全跳页并发；
// 20 秒 ×（首次 + 1 次重试）× 3 页，远低于 Vercel 的 300 秒函数上限。
const TOPIC_PAGE_TIMEOUT_MS = 20_000;
const TOPIC_PAGE_RETRIES = 1;

export default async function handler(req: any, res: any) {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }

  const logger = createRequestLogger("api.tikhub.batch", req.headers?.["x-request-id"]);
  const agentConfig = getContentAgentConfig();
  const topicRequestTimeoutMs = Math.min(agentConfig.requestTimeoutMs, TOPIC_PAGE_TIMEOUT_MS);
  const topicRequestRetries = Math.min(Math.max(0, Number(agentConfig.apiRetryAttempts) || 0), TOPIC_PAGE_RETRIES);

  const { urls, platform, days = 7, maxPages = 20, count = 400, resume = null } = readBody(req);
  const normalizedPlatform = String(platform || "douyin").toLowerCase() === "tiktok" ? "tiktok" : "douyin";
  let recentDays;
  try {
    recentDays = parseRecentDays(days);
  } catch {
    return json(res, 400, { error: `days must be an integer between 1 and ${MAX_RECENT_DAYS}`, code: "TOPIC_DAYS_INVALID" });
  }
  logger.info("route.request.start", {
    interface: "/api/tikhub/batch",
    platform: normalizedPlatform,
    urlCount: Array.isArray(urls) ? urls.length : 0,
  });

  if (!Array.isArray(urls) || urls.length === 0) {
    logger.warn("route.validation.error", { error: "urls must be a non-empty array" });
    return json(res, 400, { error: "urls must be a non-empty array" });
  }
  if (urls.length !== 1) {
    return json(res, 400, { error: "每次续拉请求只能包含一个账号", code: "TOPIC_SINGLE_ACCOUNT_REQUIRED" });
  }

  if (!TIKHUB_API_TOKEN) {
    return json(res, 500, { error: "Missing TIKHUB_API_TOKEN" });
  }

  const results: Array<Record<string, unknown>> = [];

  for (const rawUrl of urls) {
    const url = String(rawUrl || "").trim();
    if (!url) {
      results.push({ url: rawUrl, error: "Empty url" });
      continue;
    }

    const sanitizedUrl = sanitizeUrl(url);
    logger.info("tikhub.item.start", { url: safeLink(sanitizedUrl), platform: normalizedPlatform });
    if (resume?.sourceUrl && sanitizeUrl(String(resume.sourceUrl)) !== sanitizedUrl) {
      results.push({ url, platform: normalizedPlatform, error: "续拉状态与当前账号不匹配", errorStatus: 400 });
      continue;
    }

    let secUserId = String(resume?.secUserId || "").trim();
    let secUserResponse: any = null;
    let resolvedUsername = String(resume?.username || "").trim();
    let retryResume: Record<string, unknown> = {
      cursor: resume?.cursor ?? 0,
      pageOffset: resume?.pageOffset ?? 0,
      ...(secUserId ? { secUserId } : {}),
      ...(resolvedUsername ? { username: resolvedUsername } : {}),
      sourceUrl: sanitizedUrl,
    };
    const slicePageBudget = MAX_TOPIC_SLICE_PAGES;

    try {

      if (normalizedPlatform === "tiktok") {
        // TikTok：主页链接形如 https://www.tiktok.com/@username，提取 username 后查 sec_user_id。
        const username = resolvedUsername || (() => {
          const m = sanitizedUrl.match(/tiktok\.com\/@?([A-Za-z0-9_.]+)/i);
          return m ? m[1] : "";
        })();
        resolvedUsername = username;
        if (!username) {
          results.push({
            url,
            platform: normalizedPlatform,
            error: "无法识别 TikTok 用户名，请输入形如 https://www.tiktok.com/@username 的主页链接",
          });
          continue;
        }
        if (username && !secUserId && resume?.accountResolved !== true) {
          // TikHub TikTok 端点：用 username 换 sec_user_id（失败则 fallback 用 unique_id 直查作品）
          const secEndpoint = `${TIKHUB_BASE_URL}/api/v1/tiktok/app/v3/get_user_id_and_sec_user_id_by_username`;
          try {
            const { data: secUserData } = await fetchJson(
              appendQuery(secEndpoint, { username }),
              {
                timeoutMs: topicRequestTimeoutMs,
                retries: topicRequestRetries,
                retryBaseDelayMs: agentConfig.apiRetryBaseDelayMs,
                logger,
                interfaceName: "tikhub:tiktok:get_sec_user_id",
                retryableExtraStatuses: 400,
                headers: { Authorization: `Bearer ${TIKHUB_API_TOKEN}` },
              },
            );
            secUserResponse = secUserData;
            secUserId = secUserData?.data?.sec_user_id || secUserData?.sec_user_id || "";
          } catch (secError) {
            if (Number((secError as any)?.status) === 402) throw secError;
            // sec_user_id 解析失败不致命，下方用 unique_id 兜底
            logger.warn("tikhub.tiktok.sec_user_id.fallback", {
              username,
              error: secError instanceof Error ? secError.message : "sec_user_id resolve failed",
            });
          }
        }
        retryResume = {
          ...retryResume,
          secUserId,
          username,
          accountResolved: true,
        };
        const videosEndpoint = `${TIKHUB_BASE_URL}/api/v1/tiktok/app/v3/fetch_user_post_videos`;
        const videosParams: Record<string, unknown> = { count: 20 };
        if (secUserId) {
          videosParams.sec_user_id = secUserId;
        } else if (username) {
          videosParams.unique_id = username;
        } else {
          videosParams.url = sanitizedUrl;
        }
        const collection = await collectRecentAwemePages({
          platform: normalizedPlatform,
          days: recentDays,
          maxPages,
          slicePages: slicePageBudget,
          startCursor: resume?.cursor ?? 0,
          pageOffset: resume?.pageOffset ?? 0,
          maxVideos: count,
          expectedPageSize: 20,
          logger,
          logFields: { url: safeLink(sanitizedUrl), pageType: "tiktok" },
          fetchPage: (cursor: unknown, page: number) => fetchJson(
            appendQuery(videosEndpoint, { ...videosParams, max_cursor: cursor }),
            {
              timeoutMs: topicRequestTimeoutMs,
              retries: topicRequestRetries,
              retryBaseDelayMs: agentConfig.apiRetryBaseDelayMs,
              logger,
              interfaceName: "tikhub:tiktok:fetch_user_post_videos",
              logFields: { page },
              retryableExtraStatuses: 400,
              headers: { Authorization: `Bearer ${TIKHUB_API_TOKEN}` },
            },
          ),
        });
        const videosList = collection.videos;
        const nextResume = collection.resume ? { ...collection.resume, secUserId, username, accountResolved: true, sourceUrl: sanitizedUrl } : null;
        const videosResponse = buildCombinedVideosResponse(collection.pages, videosList, { ...collection, resume: nextResume });
        const authorName = videosList?.[0]?.author?.nickname;

        results.push({
          url,
          platform: normalizedPlatform,
          secUserId,
          authorName,
          videosCount: videosList.length,
          secUserResponse,
          videosResponse,
          pageCount: collection.pageCount,
          totalPageCount: collection.totalPageCount,
          rawVideosCount: collection.rawVideosCount,
          recentDays: collection.recentDays,
          hasMore: collection.hasMore,
          stopReason: collection.stopReason,
          isComplete: collection.isComplete,
          incompleteReason: collection.incompleteReason,
          backgroundError: collection.partialError,
          errorStatus: collection.partialErrorStatus,
          resume: nextResume,
          error: null,
        });
        logger.info("tikhub.item.end", {
          url: safeLink(sanitizedUrl),
          secUserId,
          videosCount: videosList.length,
          pageCount: collection.pageCount,
          totalPageCount: collection.totalPageCount,
          stopReason: collection.stopReason,
          hasMore: collection.hasMore,
          resumePageOffset: nextResume?.pageOffset ?? "",
          error: "",
        });
      } else {
        // 抖音：主页链接 → sec_user_id → fetch_user_post_videos
        if (!secUserId) {
          const secEndpoint = `${TIKHUB_BASE_URL}/api/v1/douyin/web/get_sec_user_id`;
          const { response: secResp, data: secUserData } = await fetchJson(
            appendQuery(secEndpoint, { url: sanitizedUrl }),
            {
              timeoutMs: topicRequestTimeoutMs,
              retries: topicRequestRetries,
              retryBaseDelayMs: agentConfig.apiRetryBaseDelayMs,
              logger,
              interfaceName: "tikhub:get_sec_user_id",
              retryableExtraStatuses: 400,
              headers: { Authorization: `Bearer ${TIKHUB_API_TOKEN}` },
            },
          );
          secUserResponse = secUserData;
          secUserId = secUserData?.data || secUserData?.sec_user_id;

          if (!secResp.ok || !secUserId) {
            results.push({
              url,
              platform: normalizedPlatform,
              secUserResponse,
              error: secUserResponse?.message || "Failed to resolve sec_user_id",
            });
            continue;
          }
        }
        retryResume = { ...retryResume, secUserId };

        const videosEndpoint = `${TIKHUB_BASE_URL}/api/v1/douyin/app/v3/fetch_user_post_videos`;
        const collection = await collectRecentAwemePages({
          platform: normalizedPlatform,
          days: recentDays,
          maxPages,
          slicePages: slicePageBudget,
          startCursor: resume?.cursor ?? 0,
          pageOffset: resume?.pageOffset ?? 0,
          maxVideos: count,
          expectedPageSize: 20,
          logger,
          logFields: { url: safeLink(sanitizedUrl), pageType: "douyin" },
          fetchPage: (cursor: unknown, page: number) => fetchJson(
            appendQuery(videosEndpoint, {
              sec_user_id: secUserId,
              count: 20,
              max_cursor: cursor,
              sort_type: 0,
            }),
            {
              timeoutMs: topicRequestTimeoutMs,
              retries: topicRequestRetries,
              retryBaseDelayMs: agentConfig.apiRetryBaseDelayMs,
              logger,
              interfaceName: "tikhub:fetch_user_post_videos",
              logFields: { page },
              retryableExtraStatuses: 400,
              headers: { Authorization: `Bearer ${TIKHUB_API_TOKEN}` },
            },
          ),
        });
        const videosList = collection.videos;
        const nextResume = collection.resume ? { ...collection.resume, secUserId, sourceUrl: sanitizedUrl } : null;
        const videosResponse = buildCombinedVideosResponse(collection.pages, videosList, { ...collection, resume: nextResume });
        const authorName = videosList?.[0]?.author?.nickname;

        results.push({
          url,
          platform: normalizedPlatform,
          secUserId,
          authorName,
          videosCount: videosList.length,
          secUserResponse,
          videosResponse,
          pageCount: collection.pageCount,
          totalPageCount: collection.totalPageCount,
          rawVideosCount: collection.rawVideosCount,
          recentDays: collection.recentDays,
          hasMore: collection.hasMore,
          stopReason: collection.stopReason,
          isComplete: collection.isComplete,
          incompleteReason: collection.incompleteReason,
          backgroundError: collection.partialError,
          errorStatus: collection.partialErrorStatus,
          resume: nextResume,
          error: null,
        });
        logger.info("tikhub.item.end", {
          url: safeLink(sanitizedUrl),
          secUserId,
          videosCount: videosList.length,
          pageCount: collection.pageCount,
          totalPageCount: collection.totalPageCount,
          stopReason: collection.stopReason,
          hasMore: collection.hasMore,
          resumePageOffset: nextResume?.pageOffset ?? "",
          error: "",
        });
      }
    } catch (error) {
      logger.error("tikhub.item.error", {
        url: safeLink(sanitizedUrl),
        error: error instanceof Error ? error.message : "Request failed",
        code: (error as any)?.code,
      });
      results.push({
        url,
        platform: normalizedPlatform,
        errorStatus: Number((error as any)?.status) || null,
        resume: retryResume,
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
