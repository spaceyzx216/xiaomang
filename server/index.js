import express from "express";
import dotenv from "dotenv";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runContentAgentWorkflow } from "../api/_lib/contentAgent/index.js";
import { getContentAgentConfig } from "../api/_lib/contentAgent/config.js";
import { appendQuery, fetchJson, isRetryableNetworkError } from "../api/_lib/contentAgent/http.js";
import { createRequestLogger, safeLink } from "../api/_lib/contentAgent/logger.js";
import { runRewriteAgent, runTranslationAgent } from "../api/_lib/contentAgent/providers.js";
import { platformRouter } from "../api/_lib/routers/platform.js";
import {
  buildCombinedVideosResponse,
  collectRecentAwemePages,
  MAX_RECENT_DAYS,
  MAX_TOPIC_SLICE_PAGES,
  parseRecentDays,
} from "../api/_lib/topicPagination.js";
import {
  buildFinalDraftMarkdown,
  normalizeBenchmarkVideos,
} from "../api/_lib/exportFormatters.js";
import {
  createFeishuBitableForTask,
  writeFinalDraftToFeishu,
  writeFinalDraftToFeishuBitable,
} from "../api/_lib/feishuClient.js";
import { getTodayTasksForUser, isActiveTaskUser, isTaskUserId } from "../api/_lib/taskStore.js";
import {
  issueTaskSession,
  readTaskSessionUserId,
  requestIsSecure,
  taskSessionCookie,
} from "../api/_lib/taskSession.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({
  path: path.resolve(__dirname, "../.env"),
});
dotenv.config({
  path: new URL("./.env", import.meta.url),
  override: true,
});

const app = express();
const port = Number(process.env.PORT || 8787);
const dataDir = path.resolve(__dirname, "data");
const finalDraftFile = path.join(dataDir, "final-drafts.json");
const baseUrl = process.env.TIKHUB_BASE_URL || "https://api.tikhub.io";
const apiToken = process.env.TIKHUB_API_TOKEN || "";
const apiRetryAttempts = Number.parseInt(process.env.AGENT_API_RETRY_ATTEMPTS || "2", 10);
const apiRetryBaseDelayMs = Number.parseInt(process.env.AGENT_API_RETRY_BASE_DELAY_MS || "500", 10);
const startupAgentConfig = getContentAgentConfig();
const TOPIC_PAGE_TIMEOUT_MS = 20_000;
const TOPIC_PAGE_RETRIES = 1;
const TOPIC_INITIAL_PAGE_RETRIES = 1;
const TOPIC_INITIAL_PAGE_RETRY_DELAY_MS = 1200;
const shouldRetryInitialTopicPage = error => (
  isRetryableNetworkError(error) || Number(error?.status) === 400
);
createRequestLogger("server", "startup").info("server.config", {
  port,
  contentProvider: startupAgentConfig.provider,
  agentWorkflowId: startupAgentConfig.mainWorkflowId,
  tikhubBaseUrl: baseUrl,
  transcriptProviders: startupAgentConfig.transcriptProviders.join(","),
  doubaoResourceId: startupAgentConfig.doubaoResourceId,
  tikhubConfigured: Boolean(startupAgentConfig.tikhubApiToken),
  deepseekConfigured: Boolean(startupAgentConfig.deepseekApiKey),
  doubaoAsrConfigured: Boolean(startupAgentConfig.doubaoApiKey || (startupAgentConfig.doubaoAppKey && startupAgentConfig.doubaoAccessKey)),
  doubaoVideoConfigured: Boolean(startupAgentConfig.doubaoVideoEndpoint && startupAgentConfig.doubaoVideoApiKey),
});

app.use(express.json({ limit: "1mb" }));

app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    service: "xiaomang-proxy",
    time: new Date().toISOString(),
  });
});

// 演示期兼容桌宠：桌宠提供员工 ID 一次，服务端将它收敛为 HttpOnly 会话。
// 正式多人上线应替换为桌宠签发的一次性、可验证启动凭证。
app.post("/api/tasks/session", async (req, res) => {
  const taskUserId = String(req.body?.taskUserId || "").trim();
  if (!isTaskUserId(taskUserId)) {
    return res.status(400).json({ success: false, error: "Invalid task user identity" });
  }

  try {
    if (!await isActiveTaskUser(taskUserId)) {
      return res.status(401).json({ success: false, error: "Task user is not active" });
    }
    const session = issueTaskSession(taskUserId);
    res.setHeader("Set-Cookie", taskSessionCookie(session, requestIsSecure(req)));
    return res.json({ success: true, data: await getTodayTasksForUser(taskUserId) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Session setup failed" });
  }
});

app.get("/api/tasks/today", async (req, res) => {
  const userId = readTaskSessionUserId(req.headers.cookie);
  if (!userId) {
    return res.status(401).json({ success: false, error: "Task session is missing or expired" });
  }

  try {
    return res.json({ success: true, data: await getTodayTasksForUser(userId) });
  } catch (error) {
    return res.status(500).json({ success: false, error: error instanceof Error ? error.message : "Task query failed" });
  }
});

const sanitizeUrl = (rawUrl) => {
  try {
    const parsed = new URL(rawUrl);
    return `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
  } catch (error) {
    return rawUrl.split("?")[0];
  }
};

const ensureDataFile = async () => {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(finalDraftFile);
  } catch {
    await fs.writeFile(finalDraftFile, JSON.stringify({ items: [] }, null, 2));
  }
};

const readFinalDrafts = async () => {
  await ensureDataFile();
  const raw = await fs.readFile(finalDraftFile, "utf-8");
  try {
    return JSON.parse(raw);
  } catch {
    return { items: [] };
  }
};

const writeFinalDrafts = async (payload) => {
  await ensureDataFile();
  await fs.writeFile(finalDraftFile, JSON.stringify(payload, null, 2));
};

app.post("/api/tikhub/batch", async (req, res) => {
  const logger = createRequestLogger("api.tikhub.batch", req.headers["x-request-id"]);
  const { urls, platform, days = 7, maxPages = 20, count = 400, resume = null } = req.body || {};
  const normalizedPlatform = String(platform || "douyin").toLowerCase() === "tiktok" ? "tiktok" : "douyin";
  let recentDays;
  try {
    recentDays = parseRecentDays(days);
  } catch {
    return res.status(400).json({
      error: `days must be an integer between 1 and ${MAX_RECENT_DAYS}`,
      code: "TOPIC_DAYS_INVALID",
    });
  }
  logger.info("route.request.start", {
    interface: "/api/tikhub/batch",
    platform: normalizedPlatform,
    urlCount: Array.isArray(urls) ? urls.length : 0,
  });

  if (!Array.isArray(urls) || urls.length === 0) {
    logger.warn("route.validation.error", { error: "urls must be a non-empty array" });
    return res.status(400).json({ error: "urls must be a non-empty array" });
  }
  if (urls.length !== 1) {
    return res.status(400).json({ error: "每次续拉请求只能包含一个账号", code: "TOPIC_SINGLE_ACCOUNT_REQUIRED" });
  }

  if (!apiToken) {
    logger.error("route.config.error", { error: "Missing TIKHUB_API_TOKEN" });
    return res.status(500).json({
      error: "Missing TIKHUB_API_TOKEN",
    });
  }

  const fetchOpts = {
    timeoutMs: Math.min(startupAgentConfig.requestTimeoutMs, TOPIC_PAGE_TIMEOUT_MS),
    retries: Math.min(Math.max(0, Number.isFinite(apiRetryAttempts) ? apiRetryAttempts : 1), TOPIC_PAGE_RETRIES),
    retryBaseDelayMs: Number.isFinite(apiRetryBaseDelayMs) ? apiRetryBaseDelayMs : 500,
    logger,
    headers: { Authorization: `Bearer ${apiToken}` },
  };

  const results = [];

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
    let secUserResponse = null;
    let resolvedUsername = String(resume?.username || "").trim();
    let retryResume = {
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
          const secEndpoint = `${baseUrl}/api/v1/tiktok/app/v3/get_user_id_and_sec_user_id_by_username`;
          try {
            const { data: secUserData } = await fetchJson(
              appendQuery(secEndpoint, { username }),
              { ...fetchOpts, interfaceName: "tikhub:tiktok:get_sec_user_id", retryableExtraStatuses: 400 },
            );
            secUserResponse = secUserData;
            secUserId = secUserData?.data?.sec_user_id || secUserData?.sec_user_id || "";
          } catch (secError) {
            if (Number(secError?.status) === 402) throw secError;
            logger.warn("tikhub.tiktok.sec_user_id.fallback", {
              username,
              error: secError instanceof Error ? secError.message : "sec_user_id resolve failed",
            });
          }
        }
        retryResume = { ...retryResume, secUserId, username, accountResolved: true };
        const videosEndpoint = `${baseUrl}/api/v1/tiktok/app/v3/fetch_user_post_videos`;
        const videosParams = { count: 20 };
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
          initialPageRetries: TOPIC_INITIAL_PAGE_RETRIES,
          initialPageRetryDelayMs: TOPIC_INITIAL_PAGE_RETRY_DELAY_MS,
          shouldRetryInitialPageError: shouldRetryInitialTopicPage,
          logger,
          logFields: { url: safeLink(sanitizedUrl), pageType: "tiktok" },
          fetchPage: (cursor, page) => fetchJson(
            appendQuery(videosEndpoint, { ...videosParams, max_cursor: cursor }),
            {
              ...fetchOpts,
              interfaceName: "tikhub:tiktok:fetch_user_post_videos",
              logFields: { page },
              retryableExtraStatuses: 400,
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
          const secEndpoint = `${baseUrl}/api/v1/douyin/web/get_sec_user_id`;
          const { response: secResp, data: secUserData } = await fetchJson(
            appendQuery(secEndpoint, { url: sanitizedUrl }),
            { ...fetchOpts, interfaceName: "tikhub:get_sec_user_id", retryableExtraStatuses: 400 },
          );
          secUserResponse = secUserData;
          secUserId = secUserData?.data || secUserData?.sec_user_id;

          if (!secResp.ok || !secUserId) {
            logger.warn("tikhub.item.failed", {
              step: "get_sec_user_id",
              status: secResp.status,
              error: secUserData?.message || "Failed to resolve sec_user_id",
            });
            results.push({
              url,
              platform: normalizedPlatform,
              secUserResponse,
              error: secUserData?.message || "Failed to resolve sec_user_id",
            });
            continue;
          }
        }
        retryResume = { ...retryResume, secUserId };

        const appVideosEndpoint = `${baseUrl}/api/v1/douyin/app/v3/fetch_user_post_videos`;
        const webVideosEndpoint = `${baseUrl}/api/v1/douyin/web/fetch_user_post_videos`;
        const initialLogicalPage = (Number(resume?.pageOffset) || 0) + 1;
        let useWebVideosEndpoint = false;
        const fetchDouyinVideosPage = async (cursor, page) => {
          const appRequest = () => fetchJson(
            appendQuery(appVideosEndpoint, {
              sec_user_id: secUserId,
              count: 20,
              max_cursor: cursor,
              sort_type: 0,
            }),
            {
              ...fetchOpts,
              interfaceName: "tikhub:douyin:app:fetch_user_post_videos",
              logFields: { page },
              retryableExtraStatuses: 400,
            },
          );
          const webRequest = () => fetchJson(
            appendQuery(webVideosEndpoint, {
              sec_user_id: secUserId,
              count: 20,
              max_cursor: cursor,
              filter_type: 0,
            }),
            {
              ...fetchOpts,
              interfaceName: "tikhub:douyin:web:fetch_user_post_videos",
              logFields: { page },
            },
          );

          if (useWebVideosEndpoint) return webRequest();
          try {
            return await appRequest();
          } catch (error) {
            if (page !== initialLogicalPage || !shouldRetryInitialTopicPage(error)) throw error;
            useWebVideosEndpoint = true;
            logger.warn("tikhub.douyin.app_to_web_fallback", {
              page,
              error: error instanceof Error ? error.message : "App V3 request failed",
              code: error?.code,
              status: error?.status,
            });
            return webRequest();
          }
        };
        const collection = await collectRecentAwemePages({
          platform: normalizedPlatform,
          days: recentDays,
          maxPages,
          slicePages: slicePageBudget,
          startCursor: resume?.cursor ?? 0,
          pageOffset: resume?.pageOffset ?? 0,
          maxVideos: count,
          expectedPageSize: 20,
          initialPageRetries: TOPIC_INITIAL_PAGE_RETRIES,
          initialPageRetryDelayMs: TOPIC_INITIAL_PAGE_RETRY_DELAY_MS,
          shouldRetryInitialPageError: shouldRetryInitialTopicPage,
          logger,
          logFields: { url: safeLink(sanitizedUrl), pageType: "douyin" },
          fetchPage: fetchDouyinVideosPage,
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
      });
      results.push({
        url,
        platform: normalizedPlatform,
        errorStatus: Number(error?.status) || null,
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
  return res.json({ results });
});

// platform 路由（accounts/search、topics/batch、topics/share-link）合并为单个 handler。
// 共享 handler 同时服务线上 Vercel（api/platform.ts）与本地 Express，按 req.url 末尾分发。
app.post("/api/platform/accounts/search", (req, res) => platformRouter(req, res));
app.post("/api/platform/topics/batch", (req, res) => platformRouter(req, res));
app.post("/api/platform/topics/share-link", (req, res) => platformRouter(req, res));

app.post("/api/agent/workflow/stream-run", async (req, res) => {
  const logger = createRequestLogger("api.agent.workflow.stream-run", req.headers["x-request-id"]);
  const agentConfig = getContentAgentConfig();
  const body = {
    ...req.body,
    workflow_id: req.body?.workflow_id || agentConfig.mainWorkflowId,
  };

  if (body.bot_id && body.app_id) {
    logger.warn("route.validation.error", { error: "bot_id and app_id cannot be specified together" });
    return res.status(400).json({
      error: "bot_id and app_id cannot be specified together",
    });
  }

  logger.info("route.request.start", {
    interface: "/api/agent/workflow/stream-run",
    workflowId: body.workflow_id,
    mode: "agent",
  });

  return runContentAgentWorkflow(req, res, { body, config: agentConfig, logger });
});

app.post("/api/final-drafts", async (req, res) => {
  const {
    titleDraft = "",
    hookDraft = "",
    scriptDraft = "",
    rewriteDraft = "",
    translationDraft = "",
    benchmarkVideos = [],
  } = req.body || {};

  try {
    const db = await readFinalDrafts();
    const item = {
      id: `draft_${Date.now()}`,
      createdAt: new Date().toISOString(),
      titleDraft: String(titleDraft || ""),
      hookDraft: String(hookDraft || ""),
      scriptDraft: String(scriptDraft || ""),
      rewriteDraft: String(rewriteDraft || ""),
      translationDraft: String(translationDraft || ""),
      benchmarkVideos: normalizeBenchmarkVideos(benchmarkVideos),
    };

    db.items = [item, ...(Array.isArray(db.items) ? db.items : [])].slice(0, 200);
    await writeFinalDrafts(db);

    return res.json({ success: true, item });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Save failed",
    });
  }
});

app.get("/api/final-drafts", async (_req, res) => {
  try {
    const db = await readFinalDrafts();
    return res.json({ success: true, items: Array.isArray(db.items) ? db.items : [] });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Read failed",
    });
  }
});

app.delete("/api/final-drafts", async (_req, res) => {
  try {
    await writeFinalDrafts({ items: [] });
    return res.json({ success: true, removedAll: true });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Delete all failed",
    });
  }
});

app.delete("/api/final-drafts/:id", async (req, res) => {
  const id = String(req.params?.id || "").trim();
  if (!id) {
    return res.status(400).json({ success: false, error: "id is required" });
  }

  try {
    const db = await readFinalDrafts();
    const list = Array.isArray(db.items) ? db.items : [];
    const next = list.filter((item) => String(item?.id || "") !== id);
    await writeFinalDrafts({ items: next });
    return res.json({ success: true, removed: list.length - next.length });
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Delete failed",
    });
  }
});

app.post("/api/export/feishu", async (req, res) => {
  const logger = createRequestLogger("api.export.feishu", req.headers["x-request-id"]);
  logger.info("route.request.start", {
    interface: "/api/export/feishu",
    mode: "docx.write",
  });

  try {
    const result = await writeFinalDraftToFeishu(req.body || {}, { logger });
    logger.info("route.request.done", {
      interface: "/api/export/feishu",
      documentId: result.documentId,
      blocksCreated: result.blocksCreated,
    });
    return res.json({
      success: true,
      message: "已写入飞书文档",
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feishu export failed";
    logger.error("route.request.error", {
      interface: "/api/export/feishu",
      code: error?.code,
      error: message,
    });
    return res.status(error?.status || 500).json({
      success: false,
      error: message,
      code: error?.code,
      markdown: buildFinalDraftMarkdown(req.body || {}),
    });
  }
});

app.post("/api/export/bitable", async (req, res) => {
  const logger = createRequestLogger("api.export.bitable", req.headers["x-request-id"]);
  logger.info("route.request.start", {
    interface: "/api/export/bitable",
    mode: "bitable.write",
  });

  try {
    const result = await writeFinalDraftToFeishuBitable(req.body || {}, { logger });
    logger.info("route.request.done", {
      interface: "/api/export/bitable",
      appToken: result.appToken,
      tableId: result.tableId,
      recordCount: result.recordCount,
      recordsCreated: result.recordsCreated,
      appCreated: result.appCreated,
      tableCreated: result.tableCreated,
      fieldsCreated: result.fieldsCreated,
    });
    return res.json({
      success: true,
      message: "已写入飞书多维表格",
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feishu bitable export failed";
    logger.error("route.request.error", {
      interface: "/api/export/bitable",
      code: error?.code,
      error: message,
    });
    return res.status(error?.status || 500).json({
      success: false,
      error: message,
      code: error?.code,
    });
  }
});

app.post("/api/export/bitable/create", async (req, res) => {
  const logger = createRequestLogger("api.export.bitable.create", req.headers["x-request-id"]);
  logger.info("route.request.start", {
    interface: "/api/export/bitable/create",
    mode: "bitable.create",
  });

  try {
    const result = await createFeishuBitableForTask(req.body || {}, { logger });
    logger.info("route.request.done", {
      interface: "/api/export/bitable/create",
      appToken: result.appToken,
      tableId: result.tableId,
      appCreated: result.appCreated,
      tableCreated: result.tableCreated,
      fieldsCreated: result.fieldsCreated,
    });
    return res.json({
      success: true,
      message: "已创建飞书多维表格",
      ...result,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Feishu bitable create failed";
    logger.error("route.request.error", {
      interface: "/api/export/bitable/create",
      code: error?.code,
      error: message,
    });
    return res.status(error?.status || 500).json({
      success: false,
      error: message,
      code: error?.code,
    });
  }
});

app.post("/api/agent/translation", async (req, res) => {
  const logger = createRequestLogger("api.agent.translation", req.headers["x-request-id"]);
  const payload = req.body?.payload || req.body || {};
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
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Translation failed";
    logger.error("route.request.error", {
      interface: "/api/agent/translation",
      code: error?.code,
      error: message,
    });
    return res.status(error?.status || 500).json({ error: message, code: error?.code });
  }
});

app.post("/api/agent/rewrite", async (req, res) => {
  const logger = createRequestLogger("api.agent.rewrite", req.headers["x-request-id"]);
  const scripts = Array.isArray(req.body?.scripts) ? req.body.scripts : [];
  const targetPlatform = String(req.body?.targetPlatform || req.body?.target_platform || "douyin");
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
    return res.json(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Rewrite failed";
    logger.error("route.request.error", {
      interface: "/api/agent/rewrite",
      code: error?.code,
      error: message,
    });
    return res.status(error?.status || 500).json({ error: message, code: error?.code });
  }
});

app.listen(port, () => {
  console.log(`[tikhub-proxy] listening on http://localhost:${port}`);
});
