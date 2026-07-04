/**
 * 视频号 platform 路由的共享 handler。
 *
 * 背景：Vercel Hobby 限 12 个 Serverless Function。原先 platform 下有 3 个
 * 路由文件（accounts/search、topics/batch、topics/share-link），各自独立成函数。
 * 合并后只有 api/platform.ts 一个 Vercel 函数，通过 vercel.json 的 rewrite 把
 * /api/platform/* 都路由到它，再由本 handler 按 req.url 末尾路径分发。
 *
 * 本地 Express（server/index.js）也调用同一份 handler，保证线上线下零分叉。
 */
import { json, readBody } from "./http-util.js";
import { getContentAgentConfig } from "../contentAgent/config.js";
import { createRequestLogger } from "../contentAgent/logger.js";
import {
  fetchPlatformTopics,
  fetchWeChatChannelsShareLink,
  searchPlatformAccounts,
} from "../platformAdapters.js";

// 从 req 中提取"子动作"路径段，兼容 Vercel（rewrite 后 req.url 变成 destination，
// 原始路径在 x-forwarded-uri header）与 Express（req.url / req.path 即原始路径）。
// 例：/api/platform/accounts/search  → "accounts/search"
//     /api/platform/topics/batch     → "topics/batch"
//     /api/platform/topics/share-link → "topics/share-link"
const resolvePlatformAction = (req) => {
  const headers = req.headers || {};
  const raw = String(headers["x-forwarded-uri"] || req.url || req.path || "");
  const withoutQuery = raw.split("?")[0];
  const match = withoutQuery.match(/\/api\/platform\/(.+)$/);
  return match ? match[1].replace(/\/+$/, "") : "";
};

const handleAccountsSearch = async (req, res) => {
  const logger = createRequestLogger("api.platform.accounts.search", req.headers?.["x-request-id"]);
  const body = readBody(req);
  logger.info("route.request.start", {
    interface: "/api/platform/accounts/search",
    platform: body?.platform,
    keywordCount: Array.isArray(body?.keywords) ? body.keywords.length : 0,
  });
  try {
    const payload = await searchPlatformAccounts(body, getContentAgentConfig(), { logger });
    logger.info("route.request.done", {
      interface: "/api/platform/accounts/search",
      resultCount: Array.isArray(payload?.results) ? payload.results.length : 0,
    });
    return json(res, 200, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Account search failed";
    logger.error("route.request.error", {
      interface: "/api/platform/accounts/search",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { error: message, code: error?.code });
  }
};

const handleTopicsBatch = async (req, res) => {
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
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { error: message, code: error?.code });
  }
};

const handleTopicsShareLink = async (req, res) => {
  const logger = createRequestLogger("api.platform.topics.share-link", req.headers?.["x-request-id"]);
  const body = readBody(req);
  logger.info("route.request.start", {
    interface: "/api/platform/topics/share-link",
    platform: body?.platform,
  });
  try {
    const payload = await fetchWeChatChannelsShareLink(body, getContentAgentConfig(), { logger });
    logger.info("route.request.done", {
      interface: "/api/platform/topics/share-link",
    });
    return json(res, 200, payload);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Share link fetch failed";
    logger.error("route.request.error", {
      interface: "/api/platform/topics/share-link",
      code: error?.code,
      error: message,
    });
    return json(res, error?.status || 500, { error: message, code: error?.code });
  }
};

export const platformRouter = async (req, res) => {
  if (req.method !== "POST") {
    return json(res, 405, { error: "Method not allowed" });
  }
  const action = resolvePlatformAction(req);
  switch (action) {
    case "accounts/search":
      return handleAccountsSearch(req, res);
    case "topics/batch":
      return handleTopicsBatch(req, res);
    case "topics/share-link":
      return handleTopicsShareLink(req, res);
    default:
      return json(res, 404, { error: `Unknown platform action: ${action || "(empty)"}` });
  }
};
