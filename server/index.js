import express from "express";
import dotenv from "dotenv";
import { Readable } from "stream";
import { promises as fs } from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config({
  path: new URL("./.env", import.meta.url),
});

const app = express();
const port = Number(process.env.PORT || 8787);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, "data");
const finalDraftFile = path.join(dataDir, "final-drafts.json");
const baseUrl = process.env.TIKHUB_BASE_URL || "https://api.tikhub.io";
const apiToken = process.env.TIKHUB_API_TOKEN || "";
const cozeBaseUrl = process.env.COZE_BASE_URL || "https://api.coze.cn";
const cozeToken = process.env.COZE_API_TOKEN || "";
const cozeWorkflowId = process.env.COZE_WORKFLOW_ID || "";

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
  const { urls } = req.body || {};

  if (!apiToken) {
    return res.status(500).json({
      error: "Missing TIKHUB_API_TOKEN",
    });
  }

  if (!Array.isArray(urls) || urls.length === 0) {
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

    try {
      const secResp = await fetch(
        `${baseUrl}/api/v1/douyin/web/get_sec_user_id?url=${encodeURIComponent(sanitizedUrl)}`,
        {
          headers: {
            Authorization: `Bearer ${apiToken}`,
          },
        },
      );
      const secUserResponse = await secResp.json();
      const secUserId = secUserResponse?.data || secUserResponse?.sec_user_id;

      if (!secResp.ok || !secUserId) {
        results.push({
          url,
          secUserResponse,
          error: secUserResponse?.message || "Failed to resolve sec_user_id",
        });
        continue;
      }

      const videosResp = await fetch(
        `${baseUrl}/api/v1/douyin/app/v3/fetch_user_post_videos?sec_user_id=${encodeURIComponent(secUserId)}&count=20&max_cursor=0&sort_type=0`,
        {
          headers: {
            Authorization: `Bearer ${apiToken}`,
          },
        },
      );
      const videosResponse = await videosResp.json();

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
    } catch (error) {
      results.push({
        url,
        error: error instanceof Error ? error.message : "Request failed",
      });
    }
  }

  return res.json({ results });
});

app.post("/api/coze/workflow/stream-run", async (req, res) => {
  if (!cozeToken) {
    return res.status(500).json({
      error: "Missing COZE_API_TOKEN",
    });
  }

  const body = {
    ...req.body,
    workflow_id: req.body?.workflow_id || cozeWorkflowId,
  };

  if (!body.workflow_id) {
    return res.status(400).json({
      error: "workflow_id is required",
    });
  }

  if (body.bot_id && body.app_id) {
    return res.status(400).json({
      error: "bot_id and app_id cannot be specified together",
    });
  }

  try {
    const response = await fetch(`${cozeBaseUrl}/v1/workflow/stream_run`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cozeToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    res.status(response.status);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    if (!response.body) {
      return res.end("event: Error\ndata: {\"error_message\":\"No stream body\"}\n\n");
    }

    const stream = Readable.fromWeb(response.body);
    stream.on("error", () => {
      if (!res.writableEnded) {
        res.end();
      }
    });
    stream.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    return res.status(500).json({ error: message });
  }
});

app.post("/api/final-drafts", async (req, res) => {
  const {
    titleDraft = "",
    hookDraft = "",
    scriptDraft = "",
    rewriteDraft = "",
    translationDraft = "",
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
  const { titleDraft = "", hookDraft = "", scriptDraft = "", rewriteDraft = "", translationDraft = "" } = req.body || {};

  const docText = [
    "# 最终文案",
    "",
    "## 标题",
    String(titleDraft || ""),
    "",
    "## 3 秒留存",
    String(hookDraft || ""),
    "",
    "## 二创文案",
    String(scriptDraft || ""),
    "",
    "## 风格转写结果",
    String(rewriteDraft || ""),
    "",
    "## 中英翻译结果",
    String(translationDraft || ""),
    "",
  ].join("\n");

  res.setHeader("Content-Type", "application/msword; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="final-copy-${Date.now()}.doc"`);
  return res.send(docText);
});

app.post("/api/export/excel", async (req, res) => {
  const { titleDraft = "", hookDraft = "", scriptDraft = "", rewriteDraft = "", translationDraft = "" } = req.body || {};

  const esc = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
  const rows = [
    ["板块", "内容"],
    ["标题", titleDraft],
    ["3秒留存", hookDraft],
    ["二创文案", scriptDraft],
    ["风格转写结果", rewriteDraft],
    ["中英翻译结果", translationDraft],
  ];

  const csv = rows.map(row => row.map(esc).join(",")).join("\n");

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

    const sections = list.map((item, idx) => [
      `# 任务 ${idx + 1}`,
      `保存时间：${String(item?.createdAt || "")}`,
      "",
      "## 标题",
      String(item?.titleDraft || ""),
      "",
      "## 3 秒留存",
      String(item?.hookDraft || ""),
      "",
      "## 二创文案",
      String(item?.scriptDraft || ""),
      "",
      "## 风格转写结果",
      String(item?.rewriteDraft || ""),
      "",
      "## 中英翻译结果",
      String(item?.translationDraft || ""),
      "",
      "---",
      "",
    ].join("\n"));

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

    const esc = (v) => `"${String(v || "").replace(/"/g, '""')}"`;
    const rows = [
      ["序号", "保存时间", "标题", "3秒留存", "二创文案", "风格转写结果", "中英翻译结果"],
      ...list.map((item, idx) => [
        String(idx + 1),
        String(item?.createdAt || ""),
        String(item?.titleDraft || ""),
        String(item?.hookDraft || ""),
        String(item?.scriptDraft || ""),
        String(item?.rewriteDraft || ""),
        String(item?.translationDraft || ""),
      ]),
    ];

    const csv = rows.map(row => row.map(esc).join(",")).join("\n");

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
  const { titleDraft = "", hookDraft = "", scriptDraft = "", rewriteDraft = "", translationDraft = "" } = req.body || {};

  const markdown = [
    "# 最终文案",
    "",
    "## 标题",
    String(titleDraft || ""),
    "",
    "## 3 秒留存",
    String(hookDraft || ""),
    "",
    "## 二创文案",
    String(scriptDraft || ""),
    "",
    "## 风格转写结果",
    String(rewriteDraft || ""),
    "",
    "## 中英翻译结果",
    String(translationDraft || ""),
  ].join("\n");

  return res.json({
    success: true,
    message: "已生成可用于飞书文档的 Markdown 内容",
    markdown,
  });
});

app.post("/api/coze/workflows/chat", async (req, res) => {
  if (!cozeToken) {
    return res.status(500).json({
      error: "Missing COZE_API_TOKEN",
    });
  }

  const body = { ...req.body };

  if (!body.workflow_id) {
    return res.status(400).json({ error: "workflow_id is required" });
  }

  if (!Array.isArray(body.additional_messages) || body.additional_messages.length === 0) {
    return res.status(400).json({ error: "additional_messages must be a non-empty array" });
  }

  if (typeof body.parameters !== "object" || body.parameters == null) {
    body.parameters = {};
  }

  if (body.app_id && body.bot_id) {
    return res.status(400).json({ error: "app_id and bot_id cannot be specified together" });
  }

  try {
    const response = await fetch(`${cozeBaseUrl}/v1/workflows/chat`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${cozeToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });

    res.status(response.status);
    res.setHeader("Content-Type", "text/event-stream; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");

    if (!response.body) {
      return res.end("event: error\ndata: {\"msg\":\"No stream body\"}\n\n");
    }

    const stream = Readable.fromWeb(response.body);
    stream.on("error", () => {
      if (!res.writableEnded) {
        res.end();
      }
    });
    stream.pipe(res);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Request failed";
    return res.status(500).json({ error: message });
  }
});

app.listen(port, () => {
  console.log(`[tikhub-proxy] listening on http://localhost:${port}`);
});
