import express from "express";
import dotenv from "dotenv";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { runContentAgentWorkflow } from "../api/_lib/contentAgent/index.js";
import { getContentAgentConfig } from "../api/_lib/contentAgent/config.js";
import { appendQuery, fetchJson } from "../api/_lib/contentAgent/http.js";
import { createRequestLogger, safeLink } from "../api/_lib/contentAgent/logger.js";
import { runRewriteAgent, runTranslationAgent } from "../api/_lib/contentAgent/providers.js";
import {
  buildDraftListCsvRows,
  buildFinalDraftCsvRows,
  buildFinalDraftMarkdown,
  normalizeBenchmarkVideos,
  rowsToCsv,
} from "../api/_lib/exportFormatters.js";
import { writeFinalDraftToFeishu, writeFinalDraftToFeishuBitable } from "../api/_lib/feishuClient.js";

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
  const { urls } = req.body || {};
  logger.info("route.request.start", {
    interface: "/api/tikhub/batch",
    urlCount: Array.isArray(urls) ? urls.length : 0,
  });

  if (!apiToken) {
    logger.error("route.config.error", { error: "Missing TIKHUB_API_TOKEN" });
    return res.status(500).json({
      error: "Missing TIKHUB_API_TOKEN",
    });
  }

  if (!Array.isArray(urls) || urls.length === 0) {
    logger.warn("route.validation.error", { error: "urls must be a non-empty array" });
    return res.status(400).json({ error: "urls must be a non-empty array" });
  }

  const results = [];

  for (const rawUrl of urls) {
    const url = String(rawUrl || "").trim();
    if (!url) {
      results.push({ url: rawUrl, error: "Empty url" });
      continue;
    }

    const sanitizedUrl = sanitizeUrl(url);
    logger.info("tikhub.item.start", { url: safeLink(sanitizedUrl) });

    try {
      const secEndpoint = `${baseUrl}/api/v1/douyin/web/get_sec_user_id`;
      const { response: secResp, data: secUserResponse } = await fetchJson(
        appendQuery(secEndpoint, { url: sanitizedUrl }),
        {
          timeoutMs: startupAgentConfig.requestTimeoutMs,
          retries: Number.isFinite(apiRetryAttempts) ? apiRetryAttempts : 2,
          retryBaseDelayMs: Number.isFinite(apiRetryBaseDelayMs) ? apiRetryBaseDelayMs : 500,
          logger,
          interfaceName: "tikhub:get_sec_user_id",
          headers: {
            Authorization: `Bearer ${apiToken}`,
          },
        },
      );
      const secUserId = secUserResponse?.data || secUserResponse?.sec_user_id;

      if (!secResp.ok || !secUserId) {
        logger.warn("tikhub.item.failed", {
          step: "get_sec_user_id",
          status: secResp.status,
          error: secUserResponse?.message || "Failed to resolve sec_user_id",
        });
        results.push({
          url,
          secUserResponse,
          error: secUserResponse?.message || "Failed to resolve sec_user_id",
        });
        continue;
      }

      const videosEndpoint = `${baseUrl}/api/v1/douyin/app/v3/fetch_user_post_videos`;
      const { response: videosResp, data: videosResponse } = await fetchJson(
        appendQuery(videosEndpoint, {
          sec_user_id: secUserId,
          count: 20,
          max_cursor: 0,
          sort_type: 0,
        }),
        {
          timeoutMs: startupAgentConfig.requestTimeoutMs,
          retries: Number.isFinite(apiRetryAttempts) ? apiRetryAttempts : 2,
          retryBaseDelayMs: Number.isFinite(apiRetryBaseDelayMs) ? apiRetryBaseDelayMs : 500,
          logger,
          interfaceName: "tikhub:fetch_user_post_videos",
          headers: {
            Authorization: `Bearer ${apiToken}`,
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
  return res.json({ results });
});

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

app.post("/api/export/word", async (req, res) => {
  const docText = buildFinalDraftMarkdown(req.body || {});

  res.setHeader("Content-Type", "application/msword; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-copy-${Date.now()}.doc"`);
  return res.send(docText);
});

app.post("/api/export/excel", async (req, res) => {
  const csv = rowsToCsv(buildFinalDraftCsvRows(req.body || {}));

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-copy-${Date.now()}.csv"`);
  return res.send(`\uFEFF${csv}`);
});

app.post("/api/export/final-drafts/word", async (_req, res) => {
  try {
    const db = await readFinalDrafts();
    const list = Array.isArray(db?.items) ? db.items : [];

    if (list.length === 0) {
      return res.status(400).json({ success: false, error: "暂无可导出的已保存文案" });
    }

    const sections = list.map((item, idx) => {
      const body = buildFinalDraftMarkdown(item).replace(/^# 最终文案\n\n/, "");
      return [
        `# 任务 ${idx + 1}`,
        `保存时间：${String(item?.createdAt || "")}`,
        "",
        body,
        "---",
        "",
      ].join("\n");
    });

    const docText = [
      "# 全部任务最终文案汇总",
      `共 ${list.length} 份`,
      "",
      ...sections,
    ].join("\n");

    res.setHeader("Content-Type", "application/msword; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="final-drafts-all-${Date.now()}.doc"`);
    return res.send(docText);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Export failed",
    });
  }
});

app.post("/api/export/final-drafts/excel", async (_req, res) => {
  try {
    const db = await readFinalDrafts();
    const list = Array.isArray(db?.items) ? db.items : [];

    if (list.length === 0) {
      return res.status(400).json({ success: false, error: "暂无可导出的已保存文案" });
    }

    const csv = rowsToCsv(buildDraftListCsvRows(list));

    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="final-drafts-all-${Date.now()}.csv"`);
    return res.send(`\uFEFF${csv}`);
  } catch (error) {
    return res.status(500).json({
      success: false,
      error: error instanceof Error ? error.message : "Export failed",
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
